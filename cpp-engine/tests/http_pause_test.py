#!/usr/bin/env python3
"""Pause existing sequential/range curl workers, resume, and check exact bytes."""
import hashlib
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from fixture_http import ThreadingHTTPServer


def wait_for(predicate, description, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError(description)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: http_pause_test.py PATH_TO_ENGINE_FEATURES_DRIVER")
    driver = str(Path(sys.argv[1]).resolve())
    sizes = {"/sequential.bin": 2 * 1024 * 1024, "/parallel.bin": 16 * 1024 * 1024}
    block = bytes(range(256)) * 128
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def metadata(self, status, start, end):
            self.send_response(status)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Type", "application/octet-stream")
            if self.path == "/parallel.bin":
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", '"pause-fixture-v1"')
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{sizes[self.path]}")
            self.end_headers()

        def do_HEAD(self):
            self.metadata(200, 0, sizes[self.path] - 1)

        def do_GET(self):
            start, end = 0, sizes[self.path] - 1
            header = self.headers.get("Range", "")
            if header and self.path == "/parallel.bin":
                begin, finish = header.removeprefix("bytes=").split("-", 1)
                start, end = int(begin), int(finish) if finish else end
            requests.append((self.path, header))
            self.metadata(206 if header and self.path == "/parallel.bin" else 200, start, end)
            try:
                for offset in range(start, end + 1, len(block)):
                    self.wfile.write(block[: min(len(block), end - offset + 1)])
                    self.wfile.flush()
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="ldm-pause-http-") as directory:
            work = Path(directory)
            for name in ["sequential", "parallel"]:
                output = work / (name + ".bin")
                control = work / (name + ".control")
                log_path = work / (name + ".log")
                def log_text():
                    return log_path.read_text() if log_path.exists() else ""
                def partial_bytes():
                    return sum(path.stat().st_size for path in work.glob(output.name + ".part*") if path.is_file())
                environment = os.environ.copy()
                if name == "sequential":
                    environment["LDM_TEST_TRANSFER_TIMEOUT"] = "5"
                with log_path.open("w") as log:
                    process = subprocess.Popen([driver, "download", f"http://127.0.0.1:{server.server_port}/{name}.bin",
                                                str(output), "-", "-1", "-1", "0", "mp4", "4", str(control)],
                                               stdout=log, stderr=log, env=environment)
                    try:
                        wait_for(lambda: partial_bytes() > 65536, f"{name} did not start: {log_text()}")
                        control.write_text("pause")
                        wait_for(lambda: "control=pause" in log_text(), f"{name} did not receive pause")
                        time.sleep(0.25)
                        paused_bytes = partial_bytes()
                        transfer_requests = len(requests)
                        # Sequential pause outlasts its five-second active transfer
                        # deadline; the resumed transfer must still complete.
                        time.sleep(5.2 if name == "sequential" else 0.65)
                        assert process.poll() is None and partial_bytes() == paused_bytes, f"{name} kept writing during pause"
                        control.write_text("resume")
                        wait_for(lambda: "control=resume" in log_text(), f"{name} did not receive resume")
                        assert process.wait(timeout=15) == 0, log_text()
                        assert len(requests) == transfer_requests, f"{name} restarted requests instead of resuming existing workers"
                        assert output.stat().st_size == sizes[f"/{name}.bin"]
                        progress = [line.split("=", 1)[1].split("|") for line in log_text().splitlines() if line.startswith("progress=")]
                        assert progress and all(int(item[4]) == sizes[f"/{name}.bin"] for item in progress), f"{name} reported chunk length as whole-file total: {progress}"
                        expected = hashlib.sha256(block * (sizes[f"/{name}.bin"] // len(block))).hexdigest()
                        assert hashlib.sha256(output.read_bytes()).hexdigest() == expected, f"{name} output bytes changed across pause"
                        assert not list(work.glob(output.name + ".part*")), f"{name} left partial files after completion"
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait()
            # A cancellation must also release a curl worker waiting inside pause.
            output = work / "cancel-paused.bin"
            control = work / "cancel.control"
            with (work / "cancel.log").open("w") as log:
                process = subprocess.Popen([driver, "download", f"http://127.0.0.1:{server.server_port}/sequential.bin",
                                            str(output), "-", "-1", "-1", "0", "mp4", "4", str(control)], stdout=log, stderr=log)
                try:
                    wait_for(lambda: Path(str(output) + ".part").exists(), "cancellation fixture did not start")
                    control.write_text("pause")
                    time.sleep(0.25)
                    control.write_text("cancel")
                    assert process.wait(timeout=4) == 3, "paused curl worker did not cancel promptly"
                    assert not output.exists() and not Path(str(output) + ".part").exists()
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
    finally:
        server.shutdown()
        server.server_close()
    print("Sequential and parallel HTTP pause/resume retained workers and exact bytes; cancellation while paused passed")


if __name__ == "__main__":
    main()
