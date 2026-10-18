#!/usr/bin/env python3
"""Run native macOS build, regression, TLS and clean-install qualification."""
import argparse
import datetime
import json
from pathlib import Path
import platform
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True, help="new or empty folder for native evidence")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This verification must run on an actual Mac; a Linux bundle layout is insufficient")
    output = args.output_dir.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Evidence directory must be new or empty")
    output.mkdir(parents=True, exist_ok=True)
    project = Path(__file__).resolve().parents[1]
    build = output / "build"
    report = {"platform": "Darwin", "architecture": platform.machine(), "macos_version": platform.mac_ver()[0],
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "steps": [], "status": "failed",
        "desktop_launch_verified": False, "developer_signing_verified": False}
    commands = [
        ("dependencies", [sys.executable, str(project / "scripts/check_dependencies.py"), "--json"]),
        ("configure", ["cmake", "-S", str(project / "cpp-engine"), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release",
            "-DBUILD_TESTING=ON", "-DLDM_REQUIRE_VERIFIED_MEDIA_TLS=ON"]),
        ("build", ["cmake", "--build", str(build), "--parallel", "3"]),
        ("native-regressions-and-strict-tls", ["ctest", "--test-dir", str(build), "--output-on-failure"]),
        ("clean-native-install", [sys.executable, str(project / "scripts/check_native_install.py"), "--build-dir", str(build),
            "--prefix", str(output / "install"), "--report", str(output / "native-install.json")])
    ]
    for name, command in commands:
        print(f"Running {name}", flush=True)
        with (output / f"{name}.log").open("w") as log:
            try:
                result = subprocess.run(command, cwd=project, stdout=log, stderr=subprocess.STDOUT)
                code = result.returncode
            except OSError as error:
                log.write(str(error) + "\n")
                code = 1
        report["steps"].append({"name": name, "exit_code": code, "log": f"{name}.log"})
        if code:
            report["failure"] = f"{name} failed; read {name}.log"
            break
    else:
        report["status"] = "passed"
    report["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (output / "macos-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
