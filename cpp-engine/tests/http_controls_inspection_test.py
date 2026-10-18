#!/usr/bin/env python3
"""Exercise public pause/resume/cancel and inspection routes with isolated fixtures."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main():
    executable = str(Path(sys.argv[1]).resolve())
    payload = bytes(range(256)) * 12288

    class Source(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()

        def do_GET(self):
            self.do_HEAD()
            for offset in range(0, len(payload), 32768):
                try:
                    self.wfile.write(payload[offset:offset + 32768])
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                time.sleep(0.015)

    source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
    source.daemon_threads = True
    threading.Thread(target=source.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="ldm-api-controls-") as directory:
        work = Path(directory)
        tools = work / "tools"
        tools.mkdir()
        metadata = '\n'.join([
            'streams.stream.0.index=0', 'streams.stream.0.codec_type="video"',
            'streams.stream.0.codec_name="h264"', 'streams.stream.0.width=1280',
            'streams.stream.0.height=720', 'streams.stream.0.bit_rate="1000000"',
            'streams.stream.1.index=1', 'streams.stream.1.codec_type="audio"',
            'streams.stream.1.codec_name="aac"', 'streams.stream.1.tags.language="eng"',
            'streams.stream.1.disposition.default=1', 'programs.program.0.program_id=7',
            'programs.program.0.streams.stream.0.index=0',
            'programs.program.0.streams.stream.1.index=1', 'format.duration="12.5"'
        ])
        probe = tools / "ffprobe"
        probe.write_text(f"#!{sys.executable}\nimport sys\n"
                         "if 'protocol=tls' in sys.argv: print('tls_verify (default true)'); raise SystemExit(0)\n"
                         f"print({metadata!r})\n", encoding="utf-8")
        probe.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
        environment["LDM_DOWNLOAD_DIR"] = str(work / "default-downloads")
        port = free_port()
        process = subprocess.Popen([executable, "--server", str(port)], env=environment,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f"http://127.0.0.1:{port}"

        def post(route, body, expected=200):
            origin = "chrome-extension://ldm-controls-test"
            request = urllib.request.Request(base + route, data=json.dumps(body).encode(),
                headers={"Content-Type": "text/plain;charset=UTF-8", "Origin": origin})
            try:
                response = urllib.request.urlopen(request, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                assert response.status == expected, (route, response.status, response.read())
                assert response.headers.get("Access-Control-Allow-Origin") == origin
                if route == "/download" and expected == 200:
                    return None
                return json.load(response)

        def job(identifier):
            with urllib.request.urlopen(base + "/api/downloads", timeout=3) as response:
                jobs = json.load(response)["downloads"]
            return next((item for item in jobs if item["id"] == identifier), {})

        def wait(identifier, predicate):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                value = job(identifier)
                if predicate(value):
                    return value
                time.sleep(0.025)
            raise AssertionError(f"job did not reach expected state: {job(identifier)}")

        def start(identifier, output):
            post("/download", {"id": identifier, "url": f"http://127.0.0.1:{source.server_port}/file.bin",
                               "output_path": str(output), "max_connections": 1})
            wait(identifier, lambda value: value.get("bytes_downloaded", 0) > 0)

        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + "/api/health", timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.03)
            else:
                raise AssertionError("LDM API did not start")

            inspected = post("/api/inspect", {"url": "https://media.example.test/master.m3u8", "manifest_format": "hls"})
            assert inspected["duration_seconds"] == 12.5, inspected
            assert [(track["index"], track["kind"]) for track in inspected["streams"]] == [(0, "video"), (1, "audio")]
            assert inspected["streams"][0]["height"] == 720
            assert inspected["streams"][0]["program_ids"] == [7]
            assert inspected["streams"][1]["is_default"] is True
            assert inspected["streams"][1]["language"] == "eng"
            post("/api/inspect", {"url": "file:///tmp/private.mp4"}, expected=400)
            post("/api/inspect", {"url": "ftp://127.0.0.1/file.mp4"}, expected=400)
            for field, value in [("video_stream_index", 1.5), ("audio_only", "yes"), ("output_format", "gif")]:
                post("/download", {"url": "https://media.example.test/file.mp4", field: value}, expected=400)
            post("/api/pause", {"id": "missing-job"}, expected=409)

            output = work / "resumed.bin"
            start("api-resume-test", output)
            assert post("/api/pause", {"id": "api-resume-test"})["status"] == "paused"
            paused = job("api-resume-test")
            assert paused["status"] == "paused" and paused["bytes_per_second"] == 0
            time.sleep(0.2)
            partial = Path(str(output) + ".part")
            size = partial.stat().st_size
            time.sleep(0.4)
            assert partial.stat().st_size == size, "paused API worker kept writing data"
            assert post("/api/resume", {"id": "api-resume-test"})["status"] == "downloading"
            completed = wait("api-resume-test", lambda value: value.get("status") in ("completed", "failed"))
            assert completed["status"] == "completed", completed
            assert hashlib.sha256(output.read_bytes()).digest() == hashlib.sha256(payload).digest()

            start("api-default-folder", "relative.bin")
            default_job = wait("api-default-folder", lambda value: value.get("status") in ("completed", "failed"))
            assert default_job["status"] == "completed", default_job
            assert (work / "default-downloads/relative.bin").read_bytes() == payload

            cancelled_output = work / "cancelled.bin"
            start("api-cancel-paused", cancelled_output)
            post("/api/pause", {"id": "api-cancel-paused"})
            post("/api/cancel", {"id": "api-cancel-paused"})
            stopped = wait("api-cancel-paused", lambda value: value.get("status") in ("cancelled", "failed", "completed"))
            assert stopped["status"] == "cancelled", stopped
            assert not cancelled_output.exists() and not Path(str(cancelled_output) + ".part").exists()

            process.terminate()
            process.wait(timeout=3)
            environment["LDM_DOWNLOAD_DIR"] = "relative-folder"
            port = free_port()
            base = f"http://127.0.0.1:{port}"
            process = subprocess.Popen([executable, "--server", str(port)], env=environment,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + "/api/health", timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.03)
            else:
                raise AssertionError("Invalid-folder validation server did not start")
            rejected = post("/download", {"url": f"http://127.0.0.1:{source.server_port}/file.bin",
                                          "output_path": "relative.bin"}, expected=400)
            assert "absolute folder path" in rejected["error"]
        finally:
            process.terminate()
            process.wait(timeout=3)
            source.shutdown()
            source.server_close()
    print("Public pause/resume, cancel while paused, byte integrity, inspection JSON and request validation passed")


if __name__ == "__main__":
    main()
