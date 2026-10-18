#!/usr/bin/env python3
"""Report local build/runtime prerequisites without installing anything."""

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys


def command_info(name, arguments):
    path = shutil.which(name)
    if not path:
        return {"available": False, "path": None, "version": None}
    try:
        result = subprocess.run([path, *arguments], capture_output=True, text=True, timeout=10)
        lines = (result.stdout or result.stderr).splitlines()
        return {"available": result.returncode == 0, "path": path,
                "version": lines[0] if lines else "unknown"}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"available": False, "path": path, "version": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-only", action="store_true",
                        help="check direct downloads and HLS/DASH runtime prerequisites")
    parser.add_argument("--json", action="store_true", help="print a machine-readable report")
    args = parser.parse_args()
    commands = {"ffmpeg": ["-version"], "ffprobe": ["-version"]}
    if not args.runtime_only:
        commands.update({"cmake": ["--version"], "c++": ["--version"],
                         "node": ["--version"]})
    report = {"platform": platform.platform(), "architecture": platform.machine(),
              "python": platform.python_version(), "tools": {}, "problems": [], "warnings": []}
    if not args.runtime_only and sys.version_info < (3, 9):
        report["problems"].append("Release tooling requires Python 3.9 or newer.")
    if platform.system() not in ("Linux", "Darwin"):
        report["problems"].append("Native release packaging supports Linux and macOS.")
    for name, arguments in commands.items():
        info = command_info(name, arguments)
        report["tools"][name] = info
        if not info["available"]:
            report["problems"].append(f"Missing or unusable {name}.")
    node = report["tools"].get("node", {})
    if node.get("available"):
        match = re.match(r"v?(\d+)", node["version"])
        if not match or int(match[1]) < 18:
            report["problems"].append("Regression checks require Node.js 18 or newer.")
    cmake = report["tools"].get("cmake", {})
    if cmake.get("available"):
        match = re.search(r"(\d+)\.(\d+)", cmake["version"])
        if not match or tuple(map(int, match.groups())) < (3, 16):
            report["problems"].append("Builds require CMake 3.16 or newer.")
    probe = report["tools"].get("ffprobe", {})
    if probe.get("available"):
        try:
            tls = subprocess.run([probe["path"], "-hide_banner", "-h", "protocol=tls"],
                                 capture_output=True, text=True, timeout=10)
            default = re.search(r"tls_verify[^\n]*\(default (0|1|false|true)\)", tls.stdout + tls.stderr)
            report["media_tls_default_verification"] = default[1] in ("1", "true") if default else None
            if default and default[1] in ("0", "false"):
                report["warnings"].append(
                    "FFmpeg disables TLS verification by default. LDM enables it for HTTPS inputs, "
                    "but nested playlist TLS must be verified with the installed helper before a stable release.")
        except (OSError, subprocess.TimeoutExpired) as error:
            report["warnings"].append(f"Could not inspect FFmpeg TLS defaults: {error}")
    report["notes"] = [
        "CMake configure checks the C++20 compiler and libcurl development library.",
        "FFmpeg and ffprobe are external optional tools for media inspection and HLS/DASH; direct files use libcurl.",
        "This check does not install dependencies or verify browser installation/signing.",
    ]
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"{report['platform']} ({report['architecture']}); Python {report['python']}")
        for name, info in report["tools"].items():
            print(f"{'OK' if info['available'] else 'MISSING'} {name}: {info['version'] or 'not found'}")
        for problem in report["problems"]:
            print(f"ERROR: {problem}")
        for warning in report["warnings"]:
            print(f"WARNING: {warning}")
        for note in report["notes"]:
            print(note)
    return 1 if report["problems"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
