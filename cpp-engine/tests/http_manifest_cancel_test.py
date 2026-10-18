#!/usr/bin/env python3
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def post(base, route, payload):
    request = urllib.request.Request(
        base + route,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "text/plain;charset=UTF-8"},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=3).close()


def wait_for_job(base, job_id, predicate, description, timeout=5):
    deadline = time.monotonic() + timeout
    job = None
    while time.monotonic() < deadline:
        with urllib.request.urlopen(base + "/api/downloads", timeout=3) as response:
            status = json.load(response)
        job = next((item for item in status["downloads"] if item["id"] == job_id), None)
        if job and predicate(job):
            return job
        time.sleep(0.05)
    raise AssertionError(f"{description}: {job}")


def assert_child_stopped(pid_file):
    pid = int(pid_file.read_text(encoding="utf-8"))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError(f"cancelled media helper process {pid} is still running")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: http_manifest_cancel_test.py PATH_TO_LDM_EXECUTABLE")

    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix="ldm-manifest-cancel-") as directory:
        tools = Path(directory) / "tools"
        tools.mkdir()
        ffprobe = tools / "ffprobe"
        ffprobe.write_text(
            f"#!{sys.executable}\n"
            "import os, signal, sys, time\n"
            "if 'protocol=tls' in sys.argv: print('tls_verify (default true)'); raise SystemExit(0)\n"
            "from pathlib import Path\n"
            "if 'probe-blocked' in sys.argv[-1]:\n"
            "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "    marker = Path(os.environ['LDM_MANIFEST_TEST_DIRECTORY']) / 'probe-blocked.pid'\n"
            "    marker.write_text(str(os.getpid()), encoding='utf-8')\n"
            "    time.sleep(60)\n"
            "print('streams.stream.0.index=0\\nstreams.stream.0.codec_type=\"video\"\\nstreams.stream.0.codec_name=\"h264\"\\nstreams.stream.0.width=1280\\nstreams.stream.0.height=720\\nformat.duration=\"30.0\"', flush=True)\n",
            encoding="utf-8",
        )
        ffmpeg = tools / "ffmpeg"
        ffmpeg.write_text(
            f"#!{sys.executable}\n"
            "import os, sys, time\n"
            "if 'protocol=tls' in sys.argv: print('tls_verify (default true)'); raise SystemExit(0)\n"
            "from pathlib import Path\n"
            "directory = Path(os.environ['LDM_MANIFEST_TEST_DIRECTORY'])\n"
            "url = sys.argv[sys.argv.index('-i') + 1]\n"
            "with (directory / 'ffmpeg-launches').open('a', encoding='utf-8') as launches:\n"
            "    launches.write(url + '\\n')\n"
            "(directory / 'ffmpeg.pid').write_text(str(os.getpid()), encoding='utf-8')\n"
            "Path(sys.argv[-1]).write_bytes(b'partial MP4 output')\n"
            "i = 0\n"
            "while True:\n"
            "    i += 1\n"
            "    print(f'out_time_us={i * 100000}\\nprogress=continue', flush=True)\n"
            "    time.sleep(0.1)\n",
            encoding="utf-8",
        )
        ffprobe.chmod(0o755)
        ffmpeg.chmod(0o755)

        environment = os.environ.copy()
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
        environment["LDM_MANIFEST_TEST_DIRECTORY"] = directory
        port = free_port()
        process = subprocess.Popen(
            [executable, "--server", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            start_new_session=True,
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

            output = Path(directory) / "cancelled-live-stream.mp4"
            partial = Path(str(output) + ".part.mp4")
            job_id = "cancel-manifest-integration-0001"
            post(base, "/download", {
                "id": job_id,
                "url": "http://media.example.test/live.m3u8",
                "output_path": str(output),
                "manifest_format": "hls",
                "headers": {},
            })
            wait_for_job(
                base, job_id,
                lambda job: job["status"] == "downloading" and job["phase"] == "hls" and partial.exists(),
                "manifest processing did not create its temporary MP4",
            )
            post(base, "/api/cancel", {"id": job_id})
            job = wait_for_job(
                base, job_id,
                lambda job: job["status"] in ("cancelled", "failed", "completed"),
                "FFmpeg manifest processing did not stop", timeout=6,
            )
            if job["status"] != "cancelled":
                raise AssertionError(f"FFmpeg manifest process did not stop as cancelled: {job}")
            if output.exists() or partial.exists():
                raise AssertionError("cancelled manifest processing left a partial MP4")
            assert_child_stopped(Path(directory) / "ffmpeg.pid")

            probe_output = Path(directory) / "cancelled-probe.mp4"
            probe_partial = Path(str(probe_output) + ".part.mp4")
            probe_pid = Path(directory) / "probe-blocked.pid"
            probe_job_id = "cancel-manifest-probe-0002"
            post(base, "/download", {
                "id": probe_job_id,
                "url": "http://media.example.test/probe-blocked.m3u8",
                "output_path": str(probe_output),
                "manifest_format": "hls",
                "headers": {},
            })
            wait_for_job(
                base, probe_job_id,
                lambda job: job["status"] == "downloading" and probe_pid.exists(),
                "ffprobe did not reach the stalled probing stage",
            )
            post(base, "/api/cancel", {"id": probe_job_id})
            probe_job = wait_for_job(
                base, probe_job_id,
                lambda job: job["status"] in ("cancelled", "failed", "completed"),
                "stalled ffprobe did not stop", timeout=6,
            )
            if probe_job["status"] != "cancelled":
                raise AssertionError(f"ffprobe process did not stop as cancelled: {probe_job}")
            assert_child_stopped(probe_pid)
            if probe_output.exists() or probe_partial.exists():
                raise AssertionError("cancelled probing left a partial MP4")
            launches = (Path(directory) / "ffmpeg-launches").read_text(encoding="utf-8").splitlines()
            if launches != ["http://media.example.test/live.m3u8"]:
                raise AssertionError(f"FFmpeg launched after cancelled probing: {launches}")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    print("FFmpeg and stalled ffprobe cancellation, no late launch, and temporary-file cleanup passed")


if __name__ == "__main__":
    main()
