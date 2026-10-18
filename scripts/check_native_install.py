#!/usr/bin/env python3
"""Stage and execute a native installation against generated localhost media."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--prefix", type=Path, required=True, help="new or empty installation prefix")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    prefix = args.prefix.resolve()
    if prefix.exists() and any(prefix.iterdir()):
        parser.error("Installation prefix must be empty; existing installations are never replaced")
    host = platform.system()
    if host not in ("Linux", "Darwin"):
        parser.error("Native installation verification requires Linux or macOS")
    report = {"platform": host, "architecture": platform.machine(), "checks": [], "status": "failed"}
    process = server = None
    log = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        subprocess.run(["cmake", "--install", str(args.build_dir.resolve()), "--prefix", str(prefix)], check=True)
        relative = Path("Applications/LDM.app/Contents/MacOS/LDM") if host == "Darwin" else Path("bin/ldm-downloader")
        executable = prefix / relative
        built = args.build_dir / ("LDM.app/Contents/MacOS/LDM" if host == "Darwin" else "ldm-downloader")
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        assert executable.is_file() and os.access(executable, os.X_OK), "Installed executable is missing or not executable"
        assert digest(executable) == digest(built), "Installation changed the executable"
        report["executable_sha256"] = digest(executable)
        report["checks"].append("fresh-prefix install, executable permissions and build/install SHA-256 equality")
        if host == "Darwin":
            import plistlib
            metadata = plistlib.loads((prefix / "Applications/LDM.app/Contents/Info.plist").read_bytes())
            assert metadata["CFBundleExecutable"] == "LDM" and metadata["CFBundlePackageType"] == "APPL"
            assert metadata["CFBundleIconFile"] == "LDM.icns"
            assert (prefix / "Applications/LDM.app/Contents/Resources/LDM.icns").is_file()
            report["bundle_identifier"] = metadata["CFBundleIdentifier"]
            report["linked_libraries"] = subprocess.check_output(["otool", "-L", str(executable)], text=True)
            report["native_architectures"] = subprocess.check_output(["lipo", "-archs", str(executable)], text=True).strip()
            report["checks"].append("native macOS bundle metadata, Mach-O architectures and linked library inventory")
        else:
            assert (prefix / "share/applications/ldm.desktop").is_file()
            assert (prefix / "share/icons/hicolor/scalable/apps/ldm.svg").is_file()
            report["checks"].append("installed Linux desktop entry and icon")
        with tempfile.TemporaryDirectory(prefix="ldm-installed-check-") as directory:
            fixture = Path(directory)
            payload = bytes(range(256)) * 8192
            (fixture / "sample.bin").write_bytes(payload)
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                raise RuntimeError("FFmpeg is required to verify installed media helper discovery")
            subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=128x72:r=10",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264",
                "-preset", "ultrafast", "-g", "10", "-c:a", "aac", "-f", "hls", "-hls_time", "1",
                "-hls_list_size", "0", str(fixture / "sample.m3u8")], check=True, timeout=30)
            class Source(SimpleHTTPRequestHandler):
                def __init__(self, *values, **keywords):
                    super().__init__(*values, directory=str(fixture), **keywords)
                def log_message(self, *_values):
                    pass
                def handle(self):
                    try:
                        super().handle()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            server = ThreadingHTTPServer(("127.0.0.1", 0), Source)
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            environment = os.environ.copy()
            environment["LDM_DOWNLOAD_DIR"] = str(fixture / "downloads")
            if host == "Darwin":
                environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
            log = (fixture / "engine.log").open("w+")
            process = subprocess.Popen([str(executable), "--server", str(port)], env=environment,
                cwd=fixture, stdout=log, stderr=log)
            base = f"http://127.0.0.1:{port}"
            source = f"http://127.0.0.1:{server.server_port}"
            def get(route):
                with opener.open(base + route, timeout=3) as response:
                    return response.read()
            def post(route, body):
                request = urllib.request.Request(base + route, data=json.dumps(body).encode(),
                    headers={"Origin": "chrome-extension://ldm-install-check", "Content-Type": "text/plain;charset=UTF-8"})
                with opener.open(request, timeout=20) as response:
                    return response.read()
            deadline = time.monotonic() + 5
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Installed application exited during startup")
                try:
                    get("/api/health")
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(.05)
            assert b"LDM" in get("/") and b"<html" in get("/").lower()
            report["checks"].append("installed native executable starts and serves its embedded dashboard")
            result = json.loads(post("/api/inspect", {"url": source + "/sample.m3u8", "manifest_format": "hls"}))
            assert any(track["kind"] == "video" and track["height"] == 72 for track in result["streams"])
            assert any(track["kind"] == "audio" for track in result["streams"])
            report["checks"].append("installed engine discovers and executes ffprobe" + (" with Finder-style PATH" if host == "Darwin" else ""))
            post("/download", {"id": "installed-file-check", "url": source + "/sample.bin", "output_path": "sample.bin"})
            output = fixture / "downloads/sample.bin"
            assert output.read_bytes() == payload
            report["checks"].append("installed engine downloads exact bytes into LDM_DOWNLOAD_DIR")
            post("/download", {"id": "installed-media-check", "url": source + "/sample.m3u8", "output_path": "sample.mkv",
                "manifest_format": "hls", "output_format": "mkv"})
            media = fixture / "downloads/sample.mkv"
            assert media.is_file() and media.stat().st_size > 0
            probe = shutil.which("ffprobe")
            inspected = json.loads(subprocess.check_output([probe, "-v", "error", "-show_streams", "-of", "json", str(media)], text=True))
            assert any(track["codec_type"] == "video" and track["height"] == 72 for track in inspected["streams"])
            assert any(track["codec_type"] == "audio" for track in inspected["streams"])
            report["checks"].append("installed engine discovers ffmpeg and creates verified MKV video plus audio")
            process.terminate()
            process.wait(timeout=5)
            process = None
            server.shutdown()
            server.server_close()
            server = None
            log.seek(0)
            report["engine_log"] = log.read()
            log.close()
            log = None
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = str(error)
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if server is not None:
            server.shutdown()
            server.server_close()
        if log is not None:
            log.close()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
