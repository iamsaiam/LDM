#!/usr/bin/env python3
import hashlib
import json
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: http_head_fallback_test.py PATH_TO_LDM_EXECUTABLE")

    executable = str(Path(sys.argv[1]).resolve())
    payload = bytes((index * 47) % 251 for index in range(3 * 1024 * 1024 + 137))
    counters = {"head": 0, "probe": 0, "ranges": 0, "ignored_probe": 0, "full_get": 0}
    counters_lock = threading.Lock()

    class SourceHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            with counters_lock:
                counters["head"] += 1
            if self.path == "/lying-range.bin":
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", '"fixture-v1"')
                self.end_headers()
                return
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            range_value = self.headers.get("Range", "")
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", range_value)
            if self.path in ("/no-range.bin", "/lying-range.bin"):
                with counters_lock:
                    counters["ignored_probe" if match else "full_get"] += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("ETag", '"fixture-v1"')
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return

            if not match:
                with counters_lock:
                    counters["full_get"] += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                self.wfile.write(payload)
                return

            start, end = (int(value) for value in match.groups())
            if start == 0 and end == 0:
                with counters_lock:
                    counters["probe"] += 1
            with counters_lock:
                counters["ranges"] += 1
            if start >= len(payload) or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(payload)}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            end = min(end, len(payload) - 1)
            body = payload[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"fixture-v1"')
            self.end_headers()
            self.wfile.write(body)

    source = ThreadedHTTPServer(("127.0.0.1", 0), SourceHandler)
    source_thread = threading.Thread(target=source.serve_forever, daemon=True)
    source_thread.start()
    ldm_port = free_port()
    temporary_directory = tempfile.TemporaryDirectory(prefix="ldm-head-fallback-")
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

        output = Path(temporary_directory.name) / "head-denied.bin"
        job_id = "head-fallback-integration-0001"
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

        deadline = time.monotonic() + 15
        job = None
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            job = next((item for item in status["downloads"] if item["id"] == job_id), None)
            if job and job["status"] in ("completed", "failed"):
                break
            time.sleep(0.05)

        if not job or job["status"] != "completed":
            raise AssertionError(f"download did not recover from denied HEAD: {job}")
        if not output.is_file() or output.stat().st_size != len(payload):
            raise AssertionError("HEAD fallback did not produce the expected file size")
        if hashlib.sha256(output.read_bytes()).digest() != hashlib.sha256(payload).digest():
            raise AssertionError("HEAD fallback output differs from the source")
        with counters_lock:
            observed = dict(counters)
        if observed["head"] < 1 or observed["probe"] < 1 or observed["ranges"] < 2:
            raise AssertionError(f"expected HEAD fallback and parallel ranges, got {observed}")
        if observed["full_get"]:
            raise AssertionError(f"range-capable server received a full streaming GET: {observed}")

        fallback_output = Path(temporary_directory.name) / "ignored-range.bin"
        fallback_id = "false-range-support-streaming-0002"
        fallback_body = json.dumps({
            "id": fallback_id,
            "url": f"http://127.0.0.1:{source.server_port}/lying-range.bin",
            "output_path": str(fallback_output),
            "max_connections": 4,
            "headers": {},
        }).encode()
        fallback_request = urllib.request.Request(
            base + "/download",
            data=fallback_body,
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            method="POST",
        )
        fallback_stream = urllib.request.urlopen(fallback_request, timeout=3)
        fallback_stream.close()

        deadline = time.monotonic() + 15
        fallback_job = None
        while time.monotonic() < deadline:
            status = json.load(urllib.request.urlopen(base + "/api/downloads", timeout=3))
            fallback_job = next((item for item in status["downloads"] if item["id"] == fallback_id), None)
            if fallback_job and fallback_job["status"] in ("completed", "failed"):
                break
            time.sleep(0.05)
        if not fallback_job or fallback_job["status"] != "completed":
            raise AssertionError(f"download did not stream when range requests were ignored: {fallback_job}")
        if not fallback_output.is_file() or fallback_output.stat().st_size != len(payload):
            raise AssertionError("streaming fallback did not produce the expected file size")
        if hashlib.sha256(fallback_output.read_bytes()).digest() != hashlib.sha256(payload).digest():
            raise AssertionError("streaming fallback output differs from the source")
        with counters_lock:
            observed = dict(counters)
        if observed["ignored_probe"] != 1 or observed["full_get"] != 1:
            raise AssertionError(f"ignored range probe should stop before one full streaming GET: {observed}")
        print("Denied-HEAD fallback, verified ranges, and false-range fallback passed")
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
        temporary_directory.cleanup()


if __name__ == "__main__":
    main()
