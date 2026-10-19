#!/usr/bin/env python3
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from fixture_http import HTTPServer


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: http_cancel_test.py PATH_TO_LDM_EXECUTABLE")

    executable = str(Path(sys.argv[1]).resolve())
    total_size = 24 * 1024 * 1024

    class SourceHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(total_size))
            self.send_header("Content-Type", "application/octet-stream")
            if self.path == "/parallel.bin":
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", '"fixture-v1"')
            self.end_headers()

        def do_GET(self):
            range_mode = self.path == "/parallel.bin"
            range_header = self.headers.get("Range", "")
            start = 0
            end = total_size - 1
            status_code = 200
            if range_mode and range_header.startswith("bytes="):
                start_text, end_text = range_header[6:].split("-", 1)
                start = int(start_text)
                end = min(int(end_text), total_size - 1)
                status_code = 206
            self.send_response(status_code)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Type", "application/octet-stream")
            if range_mode:
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", '"fixture-v1"')
            if status_code == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{total_size}")
            self.end_headers()
            chunk = b"L" * 32768
            offset = start
            while offset <= end:
                piece = chunk[:min(len(chunk), end - offset + 1)]
                try:
                    self.wfile.write(piece)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                offset += len(piece)
                time.sleep(0.012)

    source = ThreadedHTTPServer(("127.0.0.1", 0), SourceHandler)
    source_thread = threading.Thread(target=source.serve_forever, daemon=True)
    source_thread.start()
    port = free_port()
    output_directory = tempfile.TemporaryDirectory(prefix="ldm-http-cancel-")
    process = subprocess.Popen(
        [executable, "--server", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"

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

        output = Path(output_directory.name) / "cancel-fixture.bin"
        job_id = "cancel-integration-0001"
        body = json.dumps({
            "id": job_id,
            "url": f"http://127.0.0.1:{source.server_port}/fixture.bin",
            "output_path": str(output),
            "headers": {},
        }).encode()
        request = urllib.request.Request(
            base + "/download",
            data=body,
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=3).close()

        deadline = time.monotonic() + 8
        job = None
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            job = next((item for item in status["downloads"] if item["id"] == job_id), None)
            if job and job["bytes_downloaded"] > 0:
                break
            time.sleep(0.05)
        if not job or job["status"] != "downloading" or job["bytes_downloaded"] == 0:
            raise AssertionError(f"fixture download did not become active: {job}")

        origin = "chrome-extension://ldm-cancel-test"
        cancel_body = json.dumps({"id": job_id}).encode()
        cancel_request = urllib.request.Request(
            base + "/api/cancel",
            data=cancel_body,
            headers={"Origin": origin, "Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        response = urllib.request.urlopen(cancel_request, timeout=3)
        if response.status != 200:
            raise AssertionError(f"cancel request returned HTTP {response.status}")
        if response.headers.get("Access-Control-Allow-Origin") != origin:
            raise AssertionError("extension origin was not allowed to cancel a download")
        if json.load(response).get("status") != "cancelling":
            raise AssertionError("cancel endpoint did not acknowledge the stopping state")

        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            job = next(item for item in status["downloads"] if item["id"] == job_id)
            if job["status"] in ("cancelled", "failed", "completed"):
                break
            time.sleep(0.05)
        if job["status"] != "cancelled":
            raise AssertionError(f"download did not settle as cancelled: {job}")
        if output.exists() or Path(str(output) + ".part").exists():
            raise AssertionError("cancelled download left a partial final output")

        parallel_output = Path(output_directory.name) / "parallel-fixture.bin"
        parallel_id = "cancel-parallel-integration-0002"
        parallel_body = json.dumps({
            "id": parallel_id,
            "url": f"http://127.0.0.1:{source.server_port}/parallel.bin",
            "output_path": str(parallel_output),
            "max_connections": 8,
            "headers": {},
        }).encode()
        parallel_request = urllib.request.Request(
            base + "/download",
            data=parallel_body,
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        urllib.request.urlopen(parallel_request, timeout=3).close()

        deadline = time.monotonic() + 8
        parallel_job = None
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            parallel_job = next((item for item in status["downloads"] if item["id"] == parallel_id), None)
            if parallel_job and parallel_job["bytes_downloaded"] > 0:
                break
            time.sleep(0.05)
        if not parallel_job or parallel_job["status"] != "downloading" or parallel_job["bytes_downloaded"] == 0:
            raise AssertionError(f"parallel fixture download did not become active: {parallel_job}")

        parallel_cancel_request = urllib.request.Request(
            base + "/api/cancel",
            data=json.dumps({"id": parallel_id}).encode(),
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        urllib.request.urlopen(parallel_cancel_request, timeout=3).close()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            parallel_job = next(item for item in status["downloads"] if item["id"] == parallel_id)
            if parallel_job["status"] in ("cancelled", "failed", "completed"):
                break
            time.sleep(0.05)
        if parallel_job["status"] != "cancelled":
            raise AssertionError(f"parallel download did not settle as cancelled: {parallel_job}")
        if parallel_output.exists():
            raise AssertionError("cancelled parallel download left a final output")
        if not Path(str(parallel_output) + ".part.meta").exists():
            raise AssertionError("validated parallel chunks were not retained for resume")

        completed_request = urllib.request.Request(
            base + "/api/cancel",
            data=cancel_body,
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        try:
            urllib.request.urlopen(completed_request, timeout=3)
            raise AssertionError("a terminal job accepted a second cancellation")
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
        print("HTTP cancellation endpoint and partial-file cleanup passed")
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
