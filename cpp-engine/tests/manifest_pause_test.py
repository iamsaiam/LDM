#!/usr/bin/env python3
"""Check process state control around both media helpers, including paused cancel."""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def wait_for(predicate, description, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError(description)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: manifest_pause_test.py PATH_TO_ENGINE_FEATURES_DRIVER")
    driver = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix="ldm-helper-pause-") as directory:
        work = Path(directory)
        tools = work / "tools"
        tools.mkdir()
        metadata = 'streams.stream.0.index=0\nstreams.stream.0.codec_type="video"\nstreams.stream.0.codec_name="h264"\nstreams.stream.0.width=1280\nstreams.stream.0.height=720\nformat.duration="30.0"'
        for name in ["ffmpeg", "ffprobe"]:
            helper = tools / name
            helper.write_text(
                f"#!{sys.executable}\n"
                "import os, signal, sys, time\n"
                "if 'protocol=tls' in sys.argv: print('tls_verify (default true)'); raise SystemExit(0)\n"
                "from pathlib import Path\n"
                "work = Path(os.environ['LDM_HELPER_FIXTURE'])\n"
                f"name = {name!r}\n"
                "url = sys.argv[sys.argv.index('-i') + 1]\n"
                "if name == 'ffprobe' and 'pause-probe' not in url:\n"
                f"    print({metadata!r}, flush=True)\n"
                "    raise SystemExit(0)\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "(work / (name + '.pid')).write_text(str(os.getpid()))\n"
                "with (work / (name + '.launches')).open('a') as output: output.write(str(os.getpid()) + '\\n')\n"
                "if name == 'ffmpeg': Path(sys.argv[-1]).write_bytes(b'partial media')\n"
                "i = 0\n"
                "while True:\n"
                "    i += 1\n"
                "    (work / (name + '.ticks')).write_text(str(i))\n"
                "    if name == 'ffmpeg': print(f'out_time_us={i * 100000}\\nprogress=continue', flush=True)\n"
                "    time.sleep(0.05)\n",
                encoding="utf-8",
            )
            helper.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
        environment["LDM_HELPER_FIXTURE"] = directory
        for stage, url in [("ffprobe", "http://fixture.test/pause-probe.m3u8"), ("ffmpeg", "http://fixture.test/pause-ffmpeg.m3u8")]:
            control = work / (stage + ".control")
            output = work / (stage + ".mp4")
            ticks = work / (stage + ".ticks")
            pid_file = work / (stage + ".pid")
            log_path = work / (stage + ".log")
            with log_path.open("w") as log:
                process = subprocess.Popen([driver, "download", url, str(output), "hls", "-1", "-1", "0", "mp4", "4", str(control)],
                                           stdout=log, stderr=log, env=environment)
                child_pid = None
                try:
                    wait_for(lambda: pid_file.exists() and ticks.exists(), stage + " did not start")
                    child_pid = int(pid_file.read_text())
                    control.write_text("pause")
                    wait_for(lambda: "control=pause" in log_path.read_text(), stage + " did not receive pause")
                    time.sleep(0.25)
                    paused_ticks = ticks.read_text()
                    time.sleep(0.4)
                    assert ticks.read_text() == paused_ticks and process.poll() is None, stage + " kept working while paused"
                    control.write_text("resume")
                    wait_for(lambda: ticks.read_text() != paused_ticks, stage + " did not resume")
                    assert int(pid_file.read_text()) == child_pid, stage + " restarted instead of resuming"
                    assert len((work / (stage + ".launches")).read_text().splitlines()) == 1, stage + " launched twice"
                    control.write_text("pause")
                    wait_for(lambda: log_path.read_text().count("control=pause") == 2, stage + " did not receive second pause")
                    time.sleep(0.15)
                    started = time.monotonic()
                    control.write_text("cancel")
                    assert process.wait(timeout=5) == 3, log_path.read_text()
                    assert time.monotonic() - started < 4, stage + " cancellation took too long"
                    try:
                        os.kill(child_pid, 0)
                    except ProcessLookupError:
                        pass
                    else:
                        raise AssertionError(stage + " survived paused cancellation")
                    assert not output.exists() and not Path(str(output) + ".part.mp4").exists(), stage + " left partial media output"
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    if child_pid is not None:
                        try:
                            os.kill(child_pid, 9)
                        except ProcessLookupError:
                            pass
    print("ffprobe/FFmpeg pause/resume retained their process; paused cancellation escalated and reaped helpers; temporary files cleaned")


if __name__ == "__main__":
    main()
