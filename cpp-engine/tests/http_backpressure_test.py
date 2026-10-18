#!/usr/bin/env python3
"""A client that stops reading progress must not block a transfer forever."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def main():
    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix="ldm-backpressure-") as directory:
        work = Path(directory)
        tools = work / "tools"
        tools.mkdir()
        metadata = ('streams.stream.0.index=0\nstreams.stream.0.codec_type="video"\n'
                    'streams.stream.0.codec_name="h264"\nstreams.stream.0.width=640\n'
                    'streams.stream.0.height=360\nformat.duration="30.0"')
        probe = tools / "ffprobe"
        probe.write_text(f"#!{sys.executable}\nimport sys\n"
                         "if 'protocol=tls' in sys.argv: print('tls_verify (default true)'); raise SystemExit(0)\n"
                         f"print({metadata!r})\n", encoding="utf-8")
        encoder = tools / "ffmpeg"
        encoder.write_text(
            f"#!{sys.executable}\n"
            "import sys\nfrom pathlib import Path\n"
            "if 'protocol=tls' in sys.argv: print('tls_verify (default true)'); raise SystemExit(0)\n"
            "Path(sys.argv[-1]).write_bytes(b'completed isolated fixture')\n"
            "for index in range(50000):\n"
            "    print(f'out_time_us={index}\\nprogress=continue', flush=True)\n"
            "print('progress=end', flush=True)\n", encoding="utf-8")
        probe.chmod(0o755)
        encoder.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        process = subprocess.Popen([executable, "--server", str(port)], cwd=work,
            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stalled = None
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + "/api/health", timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.03)
            else:
                raise AssertionError("LDM did not start")
            output = work / "completed.mp4"
            body = json.dumps({"id": "stalled-progress", "url": "https://fixture.test/master.m3u8",
                               "manifest_format": "hls", "output_path": str(output)}).encode()
            stalled = socket.socket()
            stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            stalled.settimeout(3)
            stalled.connect(("127.0.0.1", port))
            stalled.sendall(("POST /download HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                "Content-Type: text/plain;charset=UTF-8\r\n"
                f"Content-Length: {len(body)}\r\n\r\n").encode() + body)
            # Keep the socket open without draining its headers or progress body.
            deadline = time.monotonic() + 12
            job = None
            while time.monotonic() < deadline:
                with urllib.request.urlopen(base + "/api/downloads", timeout=3) as response:
                    jobs = json.load(response)["downloads"]
                job = next((item for item in jobs if item["id"] == "stalled-progress"), None)
                if job and job["status"] in ("completed", "failed"):
                    break
                time.sleep(0.05)
            assert job and job["status"] == "completed", job
            assert output.read_bytes() == b"completed isolated fixture"
        finally:
            if stalled is not None:
                stalled.close()
            process.terminate()
            process.wait(timeout=3)
    print("Undrained progress connection timed out; transfer completed and remained queryable")


if __name__ == "__main__":
    main()
