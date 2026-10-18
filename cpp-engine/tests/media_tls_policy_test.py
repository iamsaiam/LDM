#!/usr/bin/env python3
"""Verify the release runtime guard before remote media inspection."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    driver = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix="ldm-media-tls-policy-") as directory:
        tools = Path(directory)
        script = f"#!{sys.executable}\n" + '''import os, sys
from pathlib import Path
if "protocol=tls" in sys.argv:
    value = os.environ["LDM_TEST_" + Path(sys.argv[0]).name.upper()]
    print("tls_verify (default " + value + ")" if value != "missing" else "no TLS protocol")
    raise SystemExit(0)
print('streams.stream.0.index=0\\nstreams.stream.0.codec_type="video"\\nstreams.stream.0.codec_name="h264"\\nstreams.stream.0.width=160\\nstreams.stream.0.height=90')
'''
        for name in ("ffmpeg", "ffprobe"):
            helper = tools / name
            helper.write_text(script)
            helper.chmod(0o755)
        for probe, converter, accepted in (("true", "true", True), ("1", "1", True),
                ("false", "true", False), ("true", "0", False), ("missing", "true", False)):
            environment = os.environ.copy()
            environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
            environment["LDM_TEST_FFPROBE"] = probe
            environment["LDM_TEST_FFMPEG"] = converter
            result = subprocess.run([driver, "inspect", "https://fixture.test/master.m3u8"],
                env=environment, text=True, capture_output=True, timeout=10)
            if accepted:
                assert result.returncode == 0 and "|video|h264|" in result.stdout, result
            else:
                assert result.returncode != 0 and "qualified LDM media helpers" in result.stderr, result
    print("Release media guard accepts enabled defaults and rejects disabled/missing TLS for both helpers")


if __name__ == "__main__":
    main()
