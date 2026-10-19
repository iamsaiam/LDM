#!/usr/bin/env python3
"""Byte-verify real passive FTP downloads through LDM's local HTTP API.

The fixture is intentionally local, read-only and ephemeral. It supports the
FTP commands libcurl uses for metadata, passive connections and range transfers.
This verifies FTP, not FTPS certificate verification or Internet FTP servers.
"""

import hashlib
import json
import random
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from fixture_http import ThreadingHTTPServer


class PassiveFtpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, payload):
        self.payload = payload
        self.files = {"fixture.bin": payload}
        self.lock = threading.Lock()
        self.commands = []
        self.retrieval_offsets = []
        super().__init__(("127.0.0.1", 0), PassiveFtpHandler)


class PassiveFtpHandler(socketserver.StreamRequestHandler):
    def optional_command(self, command, argument):
        return False

    def send_data(self, data, payload, offset):
        with data:
            data.settimeout(5)
            body = memoryview(payload)
            try:
                for position in range(offset, len(body), 32768):
                    data.sendall(body[position:position + 32768])
            except (BrokenPipeError, ConnectionResetError):
                # FTP ranges have a start offset only. libcurl closes the
                # data socket once its requested byte count is satisfied.
                pass

    def reply(self, text):
        self.wfile.write((text + "\r\n").encode("ascii"))
        self.wfile.flush()

    def passive_listener(self):
        if self.passive is not None:
            self.passive.close()
        self.passive = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.passive.bind(("127.0.0.1", 0))
        self.passive.listen(1)
        self.passive.settimeout(5)
        return self.passive.getsockname()[1]

    def retrieve(self, filename):
        with self.server.lock:
            payload = self.server.files.get(filename.lstrip("/"))
        if payload is None:
            self.reply("550 No such fixture")
            return
        if self.passive is None:
            self.reply("425 Use EPSV or PASV first")
            return
        offset = self.offset
        self.offset = 0
        with self.server.lock:
            self.server.retrieval_offsets.append(offset)
        self.reply("150 Opening binary data connection")
        listener = self.passive
        self.passive = None
        try:
            data, peer = listener.accept()
            if peer[0] != "127.0.0.1":
                data.close()
                raise AssertionError("FTP fixture received a non-loopback data peer")
            self.send_data(data, payload, offset)
            self.reply("226 Transfer complete")
        finally:
            listener.close()

    def handle(self):
        self.request.settimeout(10)
        self.passive = None
        self.offset = 0
        self.reply("220 LDM isolated passive FTP fixture")
        try:
            while True:
                raw = self.rfile.readline(8193)
                if not raw:
                    break
                if len(raw) > 8192:
                    self.reply("500 Command too long")
                    break
                command, _, argument = raw.decode("utf-8").strip().partition(" ")
                command = command.upper()
                with self.server.lock:
                    self.server.commands.append(command)
                if command == "USER":
                    self.reply("331 Password required")
                elif command == "PASS":
                    self.reply("230 Logged in to local fixture")
                elif command == "PWD":
                    self.reply('257 "/" is current directory')
                elif command == "SYST":
                    self.reply("215 UNIX Type: L8")
                elif command in ("TYPE", "OPTS", "NOOP"):
                    self.reply("200 OK")
                elif command in ("CWD", "CDUP"):
                    self.reply("250 Directory unchanged" if argument in ("", "/", ".") else "550 No such directory")
                elif command == "SIZE":
                    with self.server.lock:
                        payload = self.server.files.get(argument.lstrip("/"))
                    self.reply(f"213 {len(payload)}" if payload is not None else "550 No such fixture")
                elif command == "MDTM":
                    self.reply("213 20260101000000")
                elif command == "FEAT":
                    self.reply("211-Features\r\n EPSV\r\n REST STREAM\r\n SIZE\r\n MDTM\r\n211 End")
                elif command == "EPSV":
                    if argument.upper() == "ALL":
                        self.reply("200 EPSV only")
                    else:
                        self.reply(f"229 Entering Extended Passive Mode (|||{self.passive_listener()}|)")
                elif command == "PASV":
                    port = self.passive_listener()
                    self.reply(f"227 Entering Passive Mode (127,0,0,1,{port // 256},{port % 256})")
                elif command == "REST":
                    try:
                        offset = int(argument)
                    except ValueError:
                        offset = -1
                    if 0 <= offset <= len(self.server.payload):
                        self.offset = offset
                        self.reply(f"350 Restarting at {offset}")
                    else:
                        self.reply("501 Invalid restart offset")
                elif command == "RETR":
                    self.retrieve(argument)
                elif command == "ABOR":
                    self.reply("226 Abort acknowledged")
                elif command == "QUIT":
                    self.reply("221 Goodbye")
                    break
                elif self.optional_command(command, argument):
                    pass
                else:
                    self.reply("502 Command not implemented")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            if self.passive is not None:
                self.passive.close()


def unused_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: ftp_download_test.py PATH_TO_LDM_EXECUTABLE")
    executable = str(Path(sys.argv[1]).resolve())
    block = random.Random(0x465450).randbytes(65536)
    payload = block * 48 + block[:137]  # Just over 3 MiB; exercise four chunks.
    expected_hash = hashlib.sha256(payload).digest()
    source = PassiveFtpServer(payload)
    source_thread = threading.Thread(target=source.serve_forever, daemon=True)
    source_thread.start()
    port = unused_port()
    base = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="ldm-ftp-check-") as temporary:
        directory = Path(temporary)
        with (directory / "engine.log").open("w+") as log:
            media_source = None
            process = subprocess.Popen([executable, "--server", str(port)], cwd=directory, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with opener.open(base + "/api/health", timeout=0.2):
                            break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError("LDM exited before FTP integration test startup")
                        time.sleep(0.05)
                else:
                    raise RuntimeError("LDM service did not become ready")

                for connections in (1, 4):
                    output = directory / f"ftp-{connections}.bin"
                    job_id = f"ftp-integration-{connections}"
                    task = {"id": job_id, "url": f"ftp://127.0.0.1:{source.server_address[1]}/fixture.bin",
                            "output_path": str(output), "max_connections": connections}
                    request = urllib.request.Request(base + "/download", data=json.dumps(task).encode(),
                                                     headers={"Content-Type": "application/json"})
                    with opener.open(request, timeout=15) as response:
                        events = [json.loads(line) for line in response]
                    if not any(event.get("event") == "completed" for event in events):
                        raise AssertionError(f"FTP download did not complete: {events}")
                    with opener.open(base + "/api/downloads", timeout=3) as response:
                        jobs = json.load(response)["downloads"]
                    job = next((job for job in jobs if job["id"] == job_id), None)
                    if not job or job["status"] != "completed":
                        raise AssertionError(f"FTP completion missing from registry: {job}")
                    if not output.is_file() or output.stat().st_size != len(payload):
                        raise AssertionError("FTP output has the wrong byte count")
                    if hashlib.sha256(output.read_bytes()).digest() != expected_hash:
                        raise AssertionError("FTP output differs from the source fixture")
                    if job["bytes_downloaded"] != len(payload) or job["total_bytes"] != len(payload):
                        raise AssertionError(f"FTP registry size is incorrect: {job}")

                with source.lock:
                    commands = set(source.commands)
                    offsets = list(source.retrieval_offsets)
                if not {"USER", "PASS", "SIZE", "RETR", "REST"}.issubset(commands):
                    raise AssertionError(f"FTP metadata/range path was not exercised: {commands}")
                if not ({"EPSV", "PASV"} & commands) or not any(offset > 0 for offset in offsets):
                    raise AssertionError(f"FTP passive byte ranges were not exercised: {offsets}")
                if shutil.which("ffmpeg") and shutil.which("ffprobe"):
                    # A valid FTP-hosted HLS stream must work, but an FTP
                    # manifest cannot make the media helpers open a local file.
                    local_segment = directory / "private-source.ts"
                    generated = subprocess.run([
                        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "mpegts", str(local_segment),
                    ], text=True, capture_output=True, timeout=15)
                    if generated.returncode != 0:
                        raise AssertionError(f"Could not create FTP media fixture: {generated.stderr}")
                    segment_bytes = local_segment.read_bytes()
                    class SegmentHandler(BaseHTTPRequestHandler):
                        def log_message(self, *_args):
                            pass
                        def do_GET(self):
                            if self.path != "/fixture.ts":
                                self.send_error(404)
                                return
                            self.send_response(200)
                            self.send_header("Content-Type", "video/mp2t")
                            self.send_header("Content-Length", str(len(segment_bytes)))
                            self.end_headers()
                            self.wfile.write(segment_bytes)
                    media_source = ThreadingHTTPServer(("127.0.0.1", 0), SegmentHandler)
                    media_source.daemon_threads = True
                    threading.Thread(target=media_source.serve_forever, daemon=True).start()
                    def playlist(segment):
                        return ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n"
                                f"#EXTINF:1,\n{segment}\n#EXT-X-ENDLIST\n").encode()
                    with source.lock:
                        # FFmpeg's HLS demuxer explicitly rejects FTP segment URLs.
                        # An FTP playlist with an HTTP segment is a valid control
                        # for remote helper input and nested protocol enforcement.
                        source.files.update({"safe.m3u8": playlist(f"http://127.0.0.1:{media_source.server_port}/fixture.ts"),
                                             "unsafe.m3u8": playlist(local_segment.as_uri())})
                    for fixture, should_complete in [("safe", True), ("unsafe", False)]:
                        output = directory / f"ftp-{fixture}.mp4"
                        task = {"id": f"ftp-media-{fixture}",
                                "url": f"ftp://127.0.0.1:{source.server_address[1]}/{fixture}.m3u8",
                                "manifest_format": "hls", "output_path": str(output)}
                        request = urllib.request.Request(base + "/download", data=json.dumps(task).encode(),
                                                         headers={"Content-Type": "application/json"})
                        with opener.open(request, timeout=15) as response:
                            events = [json.loads(line) for line in response]
                        completed = any(event.get("event") == "completed" for event in events)
                        if completed != should_complete:
                            raise AssertionError(f"FTP {fixture} media protocol handling was incorrect: {events}")
                        if should_complete:
                            inspected = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(output)],
                                                       text=True, capture_output=True, timeout=10)
                            streams = json.loads(inspected.stdout)["streams"] if inspected.returncode == 0 else []
                            if len(streams) != 2 or {stream["codec_type"] for stream in streams} != {"video", "audio"}:
                                raise AssertionError(f"Valid FTP HLS was not muxed as video+audio: {inspected.stderr}")
                        elif output.exists() or list(directory.glob(output.name + ".part*")):
                            raise AssertionError("An FTP manifest referencing local media produced output")
                    log.flush()
                    log.seek(0)
                    if "Protocol 'file' not on whitelist" not in log.read():
                        raise AssertionError("Unsafe FTP manifest failed without proving nested file protocol rejection")
                    print("FTP-hosted HLS with HTTP segment muxed successfully; nested local file protocol was explicitly denied")
                print("FTP via HTTP API: 1 and 4 connection downloads, metadata/ranges, bytes, SHA-256 and completed registry verified; FTPS not tested")
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-4000:], file=sys.stderr)
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                if media_source is not None:
                    media_source.shutdown()
                    media_source.server_close()
                source.shutdown()
                source.server_close()
                source_thread.join(timeout=2)


if __name__ == "__main__":
    main()
