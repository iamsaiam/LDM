#!/usr/bin/env python3
"""Verify real HTTPS/implicit FTPS, certificate trust, names and media TLS."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler

from ftp_download_test import PassiveFtpHandler, unused_port

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from fixture_http import ThreadingHTTPServer


class FtpsHandler(PassiveFtpHandler):
    def optional_command(self, command, argument):
        if command == "PBSZ":
            self.reply("200 Protection buffer accepted")
            return True
        if command == "PROT":
            self.protected_data = argument.upper() == "P"
            self.reply("200 Private data channel" if self.protected_data else "534 Private data required")
            return True
        return False

    def send_data(self, data, payload, offset):
        if not getattr(self, "protected_data", False):
            data.close()
            raise AssertionError("FTPS data was not protected with TLS")
        try:
            with self.server.context.wrap_socket(data, server_side=True) as secured:
                with self.server.lock:
                    self.server.encrypted_data_connections += 1
                super().send_data(secured, payload, offset)
        except (ssl.SSLError, BrokenPipeError, ConnectionResetError):
            # Range clients finish after their requested bytes, before FTP EOF.
            pass
        finally:
            data.close()


class FtpsServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, payload, context):
        self.payload = payload
        self.files = {"fixture.bin": payload}
        self.context = context
        self.lock = threading.Lock()
        self.commands = []
        self.retrieval_offsets = []
        self.encrypted_data_connections = 0
        super().__init__(("127.0.0.1", 0), FtpsHandler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        try:
            return self.context.wrap_socket(connection, server_side=True), address
        except OSError:
            connection.close()
            raise

    def handle_error(self, request, client_address):
        # Rejected certificates and clients finishing a byte range can close
        # either TLS channel while the fixture is flushing its final reply.
        if isinstance(sys.exc_info()[1], (ssl.SSLError, BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def make_certificate(work):
    authority = work / "authority.pem"
    key = work / "authority.key"
    server_key = work / "server.key"
    request = work / "server.csr"
    certificate = work / "server.pem"
    configuration = work / "authority.cnf"
    configuration.write_text("[req]\nprompt=no\ndistinguished_name=dn\n"
                             "[dn]\nCN=LDM isolated test CA\n"
                             "[authority]\nbasicConstraints=critical,CA:TRUE\n"
                             "keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n")
    extensions = work / "extensions.cnf"
    extensions.write_text("subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\n"
                          "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n"
                          "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    commands = [
        ["openssl", "req", "-x509", "-sha256", "-newkey", "rsa:2048", "-nodes", "-days", "2",
         "-subj", "/CN=LDM isolated test CA", "-keyout", str(key), "-out", str(authority),
         "-config", str(configuration), "-extensions", "authority"],
        ["openssl", "req", "-new", "-sha256", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
         "-keyout", str(server_key), "-out", str(request), "-config", str(configuration)],
        ["openssl", "x509", "-req", "-sha256", "-in", str(request), "-CA", str(authority), "-CAkey", str(key),
         "-CAcreateserial", "-out", str(certificate), "-days", "2", "-extfile", str(extensions)],
        ["openssl", "verify", "-CAfile", str(authority), str(certificate)],
    ]
    for command in commands:
        subprocess.run(command, capture_output=True, text=True, check=True, timeout=15)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certificate, server_key)
    return authority, context


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: tls_download_test.py ENGINE FEATURES_DRIVER")
    if not shutil.which("openssl"):
        print("SKIP: OpenSSL CLI required to create isolated TLS certificates")
        return 1 if os.environ.get("LDM_REQUIRE_VERIFIED_MEDIA_TLS") == "1" else 77
    engine, driver = [str(Path(value).resolve()) for value in sys.argv[1:]]
    payload = bytes(range(256)) * (3 * 4096) + b"LDM TLS fixture"
    digest = hashlib.sha256(payload).digest()
    nested_hostname_verified = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="ldm-tls-check-") as temporary:
        work = Path(temporary)
        authority, context = make_certificate(work)
        ftp = FtpsServer(payload, context)
        threading.Thread(target=ftp.serve_forever, daemon=True).start()
        media = b""
        encrypted_media = b""
        media_root = work / "dash-media"
        media_root.mkdir()
        encryption_key = bytes([19]) * 16
        if shutil.which("ffmpeg") and shutil.which("ffprobe"):
            segment = work / "segment.ts"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264",
                "-preset", "ultrafast", "-c:a", "aac", "-f", "mpegts", str(segment)],
                capture_output=True, text=True, check=True, timeout=15)
            media = segment.read_bytes()
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264",
                "-preset", "ultrafast", "-c:a", "aac", "-f", "dash", str(media_root / "manifest.mpd")],
                capture_output=True, text=True, check=True, timeout=15)
            encrypted = work / "encrypted.ts"
            subprocess.run(["openssl", "enc", "-aes-128-cbc", "-K", encryption_key.hex(),
                "-iv", "0" * 32, "-in", str(segment), "-out", str(encrypted)],
                capture_output=True, text=True, check=True, timeout=15)
            encrypted_media = encrypted.read_bytes()

        class HttpsHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def handle(self):
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass

            def respond(self, body):
                if self.path == "/fixture.bin":
                    content, kind = payload, "application/octet-stream"
                elif self.path == "/segment.ts":
                    content, kind = media, "video/mp2t"
                elif self.path == "/encrypted.ts":
                    content, kind = encrypted_media, "video/mp2t"
                elif self.path == "/key.bin":
                    content, kind = encryption_key, "application/octet-stream"
                elif self.path in ("/encrypted.m3u8", "/mismatch-key.m3u8"):
                    key_host = "127.0.0.1" if self.path == "/mismatch-key.m3u8" else "localhost"
                    content = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n"
                        f'#EXT-X-KEY:METHOD=AES-128,URI="https://{key_host}:{https.server_port}/key.bin",IV=0x' + "0" * 32
                        + "\n#EXTINF:1,\nencrypted.ts\n#EXT-X-ENDLIST\n").encode()
                    kind = "application/vnd.apple.mpegurl"
                elif self.path in ("/manifest.mpd", "/mismatch.mpd"):
                    manifest = (media_root / "manifest.mpd").read_text()
                    if self.path == "/mismatch.mpd":
                        manifest = manifest.replace("<Period", f"<BaseURL>https://127.0.0.1:{https.server_port}/</BaseURL><Period", 1)
                    content, kind = manifest.encode(), "application/dash+xml"
                elif self.path in ("/master.m3u8", "/mismatch.m3u8"):
                    segment_url = (f"https://127.0.0.1:{https.server_port}/segment.ts"
                                   if self.path == "/mismatch.m3u8" else "segment.ts")
                    content = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\n"
                               + segment_url + "\n#EXT-X-ENDLIST\n").encode()
                    kind = "application/vnd.apple.mpegurl"
                elif self.path.startswith("/") and "/" not in self.path[1:] and (media_root / self.path[1:]).is_file():
                    content, kind = (media_root / self.path[1:]).read_bytes(), "video/mp4"
                else:
                    self.send_error(404)
                    return
                start, end, status = 0, len(content) - 1, 200
                match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
                if match:
                    start = int(match[1])
                    end = min(int(match[2]) if match[2] else end, end)
                    status = 206
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Accept-Ranges", "bytes")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(content)}")
                self.end_headers()
                if body:
                    try:
                        self.wfile.write(content[start:end + 1])
                    except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                        pass

            def do_HEAD(self):
                self.respond(False)

            def do_GET(self):
                self.respond(True)

        https = ThreadingHTTPServer(("127.0.0.1", 0), HttpsHandler)
        https.daemon_threads = True
        https.socket = context.wrap_socket(https.socket, server_side=True)
        threading.Thread(target=https.serve_forever, daemon=True).start()
        plain = ThreadingHTTPServer(("127.0.0.1", 0), HttpsHandler)
        plain.daemon_threads = True
        threading.Thread(target=plain.serve_forever, daemon=True).start()
        try:
            for scenario in ("trusted", "untrusted", "hostname-mismatch"):
                environment = os.environ.copy()
                environment.pop("LDM_CA_BUNDLE", None)
                environment["NO_PROXY"] = environment["no_proxy"] = "localhost,127.0.0.1"
                if scenario != "untrusted":
                    environment["LDM_CA_BUNDLE"] = str(authority)
                host = "127.0.0.1" if scenario == "hostname-mismatch" else "localhost"
                port = unused_port()
                base = f"http://127.0.0.1:{port}"
                log_path = work / (scenario + ".log")
                with log_path.open("w+") as log:
                    process = subprocess.Popen([engine, "--server", str(port)], env=environment,
                        cwd=work, stdout=log, stderr=log)
                    try:
                        for _ in range(100):
                            try:
                                opener.open(base + "/api/health", timeout=0.2).close()
                                break
                            except OSError:
                                if process.poll() is not None:
                                    raise AssertionError("TLS-check engine exited")
                                time.sleep(0.03)
                        else:
                            raise AssertionError("TLS-check engine did not start")
                        for scheme, source_port in (("https", https.server_port), ("ftps", ftp.server_address[1])):
                            for connections in ((1, 4) if scenario == "trusted" else (1,)):
                                job_id = f"{scenario}-{scheme}-{connections}"
                                output = work / (job_id + ".bin")
                                task = {"id": job_id, "url": f"{scheme}://{host}:{source_port}/fixture.bin",
                                    "output_path": str(output), "max_connections": connections, "max_retries": 0}
                                request = urllib.request.Request(base + "/download", data=json.dumps(task).encode(),
                                    headers={"Content-Type": "application/json"})
                                with opener.open(request, timeout=12) as response:
                                    events = [json.loads(line) for line in response]
                                with opener.open(base + "/api/downloads", timeout=3) as response:
                                    job = next(item for item in json.load(response)["downloads"] if item["id"] == job_id)
                                if scenario == "trusted":
                                    assert job["status"] == "completed", (job, events, log_path.read_text())
                                    assert output.stat().st_size == len(payload)
                                    assert hashlib.sha256(output.read_bytes()).digest() == digest
                                else:
                                    assert job["status"] == "failed" and not output.exists(), (job, events)
                                    assert not list(work.glob(output.name + ".part*"))
                                    assert any(word in job.get("error", "").lower() for word in
                                        ("certificate", "ssl", "subject", "hostname")), job
                        if media:
                            url = f"https://{host}:{https.server_port}/master.m3u8"
                            inspected = subprocess.run([driver, "inspect", url], env=environment,
                                text=True, capture_output=True, timeout=10)
                            if scenario == "trusted":
                                assert inspected.returncode == 0 and "|video|h264|" in inspected.stdout, inspected
                                target = work / "trusted-media.mkv"
                                downloaded = subprocess.run([driver, "download", url, str(target), "hls", "-1", "-1",
                                    "0", "mkv", "1", str(work / "unused-control")], env=environment,
                                    text=True, capture_output=True, timeout=12)
                                assert downloaded.returncode == 0 and target.stat().st_size > 0, downloaded
                                nested = subprocess.run([driver, "inspect",
                                    f"https://localhost:{https.server_port}/mismatch.m3u8"], env=environment,
                                    text=True, capture_output=True, timeout=10)
                                # The external HLS demuxer's TLS option inheritance
                                # is not controlled by LDM's top-level arguments.
                                # Audit it separately from native curl trust checks.
                                nested_hostname_verified = nested.returncode != 0
                                for playlist, format_name in (("manifest.mpd", "dash"), ("encrypted.m3u8", "hls")):
                                    trusted_url = f"https://localhost:{https.server_port}/{playlist}"
                                    trusted_inspection = subprocess.run([driver, "inspect", trusted_url], env=environment,
                                        text=True, capture_output=True, timeout=10)
                                    assert trusted_inspection.returncode == 0 and "|video|h264|" in trusted_inspection.stdout, trusted_inspection
                                    target = work / (playlist + ".mkv")
                                    trusted_download = subprocess.run([driver, "download", trusted_url, str(target), format_name,
                                        "-1", "-1", "0", "mkv", "1", str(work / "unused-control")], env=environment,
                                        text=True, capture_output=True, timeout=12)
                                    assert trusted_download.returncode == 0 and target.stat().st_size > 0, trusted_download
                                for playlist in ("mismatch.mpd", "mismatch-key.m3u8"):
                                    invalid_nested = subprocess.run([driver, "inspect", f"https://localhost:{https.server_port}/{playlist}"],
                                        env=environment, text=True, capture_output=True, timeout=10)
                                    nested_hostname_verified = nested_hostname_verified and invalid_nested.returncode != 0
                                plain_target = work / "plain-media.mkv"
                                plain_download = subprocess.run([driver, "download",
                                    f"http://localhost:{plain.server_port}/master.m3u8", str(plain_target),
                                    "hls", "-1", "-1", "0", "mkv", "1", str(work / "unused-control")],
                                    env=environment, text=True, capture_output=True, timeout=12)
                                assert plain_download.returncode == 0 and plain_target.stat().st_size > 0, plain_download
                            else:
                                assert inspected.returncode != 0, ("Media accepted invalid TLS", scenario, inspected)
                    finally:
                        process.terminate()
                        process.wait(timeout=3)
            with ftp.lock:
                assert ftp.encrypted_data_connections > 0
                assert {"PBSZ", "PROT", "REST", "RETR"}.issubset(set(ftp.commands)), ftp.commands
                assert any(offset > 0 for offset in ftp.retrieval_offsets)
        finally:
            ftp.shutdown()
            ftp.server_close()
            https.shutdown()
            https.server_close()
            plain.shutdown()
            plain.server_close()
    print("HTTPS/FTPS trusted 1/4-connection byte/hash checks, private FTP data, untrusted CA and hostname rejection passed")
    if media:
        print("HTTPS HLS/DASH and AES-128 HLS inspection/remux trusted CA succeeded; main untrusted CA and mismatched hostname were rejected")
        print(f"External helper nested HLS/DASH segment and AES key hostname verification: {nested_hostname_verified}")
        if not nested_hostname_verified:
            print("RELEASE LIMITATION: this FFmpeg build does not enforce the parent's TLS settings on every HLS segment")
    if os.environ.get("LDM_REQUIRE_VERIFIED_MEDIA_TLS") == "1" and not nested_hostname_verified:
        raise AssertionError("Stable release qualification requires a media helper that rejects invalid nested TLS certificates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
