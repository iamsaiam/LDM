#!/usr/bin/env python3
"""Measure LDM HTTP range downloads against an explicit loopback fixture.

This measures one vs multiple LDM connections; it is not an IDM/XDM comparison
or an estimate of Internet speed. No external URL or browser profile is used.
"""

import argparse
import hashlib
import json
import os
import platform
import random
import re
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fixture_http import ThreadingHTTPServer

MIB = 1024 * 1024
FIXTURE_REVISION = 3


class BenchmarkHTTPServer(ThreadingHTTPServer):
    # The stdlib's small default listen queue can make eight simultaneous range
    # connections wait for SYN retransmission. Avoid measuring that fixture cap.
    request_queue_size = 64
    daemon_threads = True


def file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as content:
        for chunk in iter(lambda: content.read(MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_server(payload, rate):
    digest = hashlib.sha256(payload).hexdigest()
    state = {"requests": 0, "range_requests": 0, "bytes_served": 0, "active": 0, "peak_active": 0}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"' + digest + '"')
            self.end_headers()

        def do_GET(self):
            start, end, status = 0, len(payload) - 1, 200
            requested = self.headers.get("Range", "")
            if requested:
                match = re.fullmatch(r"bytes=(\d+)-(\d*)", requested)
                if not match or int(match[1]) >= len(payload):
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(payload)}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = int(match[1])
                end = min(int(match[2]) if match[2] else end, end)
                if end < start:
                    self.send_error(416)
                    return
                status = 206
            self.send_response(status)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"' + digest + '"')
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
            self.end_headers()
            with lock:
                state["requests"] += 1
                state["range_requests"] += bool(requested)
                state["active"] += 1
                state["peak_active"] = max(state["peak_active"], state["active"])
            clock_start = time.monotonic()
            sent = 0
            try:
                for offset in range(start, end + 1, 65536):
                    piece = payload[offset:min(offset + 65536, end + 1)]
                    if rate:
                        delay = clock_start + (sent + len(piece)) / rate - time.monotonic()
                        if delay > 0:
                            time.sleep(delay)
                    self.wfile.write(piece)
                    self.wfile.flush()
                    sent += len(piece)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with lock:
                    state["bytes_served"] += sent
                    state["active"] -= 1

    server = BenchmarkHTTPServer(("127.0.0.1", 0), Handler)
    return server, state, lock, digest


def report_markdown(report):
    lines = ["# LDM local HTTP benchmark", "", f"Recorded: {report['recorded_utc']}", "",
             "This is a synthetic loopback comparison of LDM connection counts. It does not",
             "measure Internet performance or establish that LDM is faster than IDM/XDM.", "",
             f"Payload: {report['payload_bytes'] / MIB:g} MiB; SHA-256 `{report['payload_sha256']}`.",
             f"Per-response throttle: {report['per_connection_mib_per_second']:g} MiB/s (0 means uncapped).",
             f"Fixture revision: {report['fixture']['revision']}; listening backlog: {report['fixture']['request_queue_size']} connections.",
             f"Trials per connection count: {report['repetitions']}; timing includes HTTP setup, transfer and output assembly; hash verification is outside timing.", "",
             "| Connections requested | Median seconds | Median MiB/s | All hashes correct |",
             "| --- | ---: | ---: | --- |"]
    for summary in report["summary"]:
        lines.append(f"| {summary['connections']} | {summary['median_seconds']:.3f} | {summary['median_mib_per_second']:.2f} | {summary['all_correct']} |")
    lines += ["", "A throttle on each response deliberately favors multiple connections. Uncapped",
              "results are limited by the local HTTP fixture, CPU, disk and OS caches. Real",
              "servers can impose a total bandwidth cap or disable range downloads.", "",
              f"Environment: {report['environment']['platform']}; {report['environment']['cpu_count']} logical CPUs; Python {report['environment']['python']}.",
              f"Executable SHA-256: `{report['executable_sha256']}`.", "",
              "Installed comparison tools were only discovered, not executed: " + json.dumps(report["comparison_tools"]) + ".", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--size-mib", type=int, default=32, help="fixture size, 8..256 MiB")
    parser.add_argument("--connections", default="1,8", help="comma-separated counts, 1..32")
    parser.add_argument("--repetitions", type=int, default=3, help="1..10 trials per connection count")
    parser.add_argument("--per-connection-mib", type=float, default=0, help="per-response cap, 0 means uncapped")
    parser.add_argument("--timeout", type=int, default=60, help="seconds per download")
    parser.add_argument("--output-dir", type=Path, required=True, help="new or empty directory for results.json and REPORT.md")
    args = parser.parse_args()
    try:
        connections = list(dict.fromkeys(int(value) for value in args.connections.split(",")))
    except ValueError:
        parser.error("Connections must be comma-separated integers")
    if (not 8 <= args.size_mib <= 256 or not 1 <= args.repetitions <= 10
            or not connections or any(not 1 <= value <= 32 for value in connections)
            or args.per_connection_mib < 0 or not 1 <= args.timeout <= 300):
        parser.error("Expected size 8..256 MiB, repetitions 1..10, connections 1..32, nonnegative cap, timeout 1..300")
    executable = args.executable.resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        parser.error("Executable must be an existing runnable LDM binary")
    output = args.output_dir.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Results directory must be empty; existing results are never replaced")
    # Generate one deterministic block, then repeat it; fixture setup is outside timing.
    payload = random.Random(0x4C444D).randbytes(MIB) * args.size_mib
    source, state, lock, expected_digest = make_server(payload, args.per_connection_mib * MIB)
    thread = threading.Thread(target=source.serve_forever, daemon=True)
    thread.start()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    report = {"schema_version": 2, "recorded_utc": datetime.now(timezone.utc).isoformat(),
              "scope": "synthetic loopback, not an Internet or IDM/XDM benchmark",
              "fixture": {"revision": FIXTURE_REVISION, "request_queue_size": source.request_queue_size,
                          "handler_chunk_bytes": 65536, "script_sha256": file_digest(Path(__file__).resolve())},
              "payload_bytes": len(payload), "payload_sha256": expected_digest,
              "per_connection_mib_per_second": args.per_connection_mib,
              "repetitions": args.repetitions, "executable_sha256": file_digest(executable),
              "environment": {"platform": platform.platform(), "architecture": platform.machine(),
                              "python": platform.python_version(), "cpu_count": os.cpu_count()},
              "comparison_tools": {name: shutil.which(name) for name in ("xdman", "xdm", "idman")},
              "trials": [], "summary": []}
    try:
        with tempfile.TemporaryDirectory(prefix="ldm-benchmark-") as temporary:
            work = Path(temporary)
            with (work / "engine.log").open("w+") as log:
                process = subprocess.Popen([str(executable), "--server", str(port)], cwd=work, stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        try:
                            with opener.open(base + "/api/health", timeout=0.2):
                                break
                        except OSError:
                            if process.poll() is not None:
                                raise RuntimeError("LDM server exited during benchmark startup")
                            time.sleep(0.05)
                    else:
                        raise RuntimeError("LDM server did not become ready")
                    for repetition in range(1, args.repetitions + 1):
                        for count in connections:
                            with lock:
                                for key in state:
                                    state[key] = 0
                            destination = work / f"trial-{repetition}-{count}.bin"
                            task = {"id": f"benchmark-{repetition}-{count}", "max_connections": count,
                                    "url": f"http://127.0.0.1:{source.server_port}/fixture.bin",
                                    "output_path": str(destination)}
                            request = urllib.request.Request(base + "/download", data=json.dumps(task).encode(),
                                                             headers={"Content-Type": "application/json"})
                            started = time.perf_counter()
                            completed = False
                            with opener.open(request, timeout=args.timeout) as response:
                                for line in response:
                                    event = json.loads(line)
                                    if event.get("event") == "error":
                                        raise RuntimeError(f"LDM failed: {event.get('message', event)}")
                                    completed |= event.get("event") == "completed"
                                    if time.perf_counter() - started > args.timeout:
                                        raise TimeoutError("Benchmark download exceeded timeout")
                            elapsed = time.perf_counter() - started
                            correct = completed and destination.is_file() and destination.stat().st_size == len(payload)
                            actual_digest = file_digest(destination) if destination.is_file() else None
                            correct = correct and actual_digest == expected_digest
                            with lock:
                                source_metrics = dict(state)
                            trial = {"repetition": repetition, "connections": count, "seconds": elapsed,
                                     "bytes": destination.stat().st_size if destination.is_file() else 0,
                                     "mib_per_second": len(payload) / elapsed / MIB,
                                     "sha256": actual_digest, "correct": correct, "source": source_metrics}
                            report["trials"].append(trial)
                            print(f"{count} connections trial {repetition}: {trial['mib_per_second']:.2f} MiB/s, {elapsed:.3f}s, correct={correct}", flush=True)
                            if not correct:
                                raise RuntimeError("Download bytes/hash did not match the fixture")
                            destination.unlink()
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
    finally:
        source.shutdown()
        source.server_close()
    for count in connections:
        trials = [trial for trial in report["trials"] if trial["connections"] == count]
        report["summary"].append({"connections": count, "median_seconds": statistics.median(trial["seconds"] for trial in trials),
                                  "median_mib_per_second": statistics.median(trial["mib_per_second"] for trial in trials),
                                  "all_correct": all(trial["correct"] for trial in trials)})
    output.mkdir(parents=True, exist_ok=True)
    with (output / "results.json").open("x") as content:
        content.write(json.dumps(report, indent=2) + "\n")
    with (output / "REPORT.md").open("x") as content:
        content.write(report_markdown(report))
    print(f"Saved benchmark evidence: {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        raise SystemExit(f"Benchmark failed: {error}")
