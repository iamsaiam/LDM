#!/usr/bin/env python3
import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: http_reconnect_test.py PATH_TO_LDM_EXECUTABLE")

    executable = str(Path(sys.argv[1]).resolve())
    payload = bytes((index * 31) % 251 for index in range(12 * 1024 * 1024))

    class SourceHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            for offset in range(0, len(payload), 32768):
                try:
                    self.wfile.write(payload[offset:offset + 32768])
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                time.sleep(0.012)

    source = ThreadedHTTPServer(("127.0.0.1", 0), SourceHandler)
    source_thread = threading.Thread(target=source.serve_forever, daemon=True)
    source_thread.start()
    ldm_port = free_port()
    output_directory = tempfile.TemporaryDirectory(prefix="ldm-http-reconnect-")
    process = subprocess.Popen(
        [executable, "--server", str(ldm_port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{ldm_port}"

    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/api/health", timeout=0.2).close()
                break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError("LDM server exited before it became ready")
                time.sleep(0.05)
        else:
            raise RuntimeError("LDM server did not start")

        output = Path(output_directory.name) / "reconnect-fixture.bin"
        job_id = "reconnect-integration-0001"
        body = json.dumps({
            "id": job_id,
            "url": f"http://127.0.0.1:{source.server_port}/fixture.bin",
            "output_path": str(output),
            "max_connections": 4,
            "headers": {},
        }).encode()
        request = urllib.request.Request(
            base + "/download",
            data=body,
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        stream_response = urllib.request.urlopen(request, timeout=3)
        if stream_response.status != 200:
            raise AssertionError(f"download request returned HTTP {stream_response.status}")
        stream_response.close()

        origin = "chrome-extension://ldm-integration-test"
        status_request = urllib.request.Request(base + "/api/downloads", headers={"Origin": origin})
        response = urllib.request.urlopen(status_request, timeout=3)
        if response.headers.get("Access-Control-Allow-Origin") != origin:
            raise AssertionError("extension origin was not allowed to read download status")
        if "GET" not in response.headers.get("Access-Control-Allow-Methods", ""):
            raise AssertionError("CORS response did not allow GET")
        jobs = json.load(response)["downloads"]
        job = next((item for item in jobs if item["id"] == job_id), None)
        if job is None or job["status"] != "downloading":
            raise AssertionError(f"closed client did not leave a visible active job: {job}")

        progress_deadline = time.monotonic() + 5
        while time.monotonic() < progress_deadline and job["bytes_downloaded"] == 0:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            job = next(item for item in status["downloads"] if item["id"] == job_id)
            time.sleep(0.1)
        if job["status"] != "downloading" or job["bytes_downloaded"] == 0:
            raise AssertionError(f"active progress was not available after the client disconnected: {job}")

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            job = next(item for item in status["downloads"] if item["id"] == job_id)
            if job["status"] == "completed":
                break
            if job["status"] == "failed":
                raise RuntimeError(job["error"])
            time.sleep(0.1)
        if job["status"] != "completed":
            raise AssertionError(f"native job did not complete: {job}")
        if not output.is_file() or output.stat().st_size != len(payload):
            raise AssertionError("completed job did not write the expected file")
        if hashlib.sha256(output.read_bytes()).digest() != hashlib.sha256(payload).digest():
            raise AssertionError("downloaded bytes differ from the source")
        print("HTTP reconnect and status endpoint passed")
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        source.shutdown()
        source.server_close()
        source_thread.join(timeout=2)
        output_directory.cleanup()


if __name__ == "__main__":
    main()
