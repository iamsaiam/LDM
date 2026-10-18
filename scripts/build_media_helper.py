#!/usr/bin/env python3
"""Build a pinned FFmpeg helper with inherited HLS/DASH TLS settings."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import tarfile
import urllib.request

VERSION = "9.0.2"
SOURCE_SHA256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
SOURCE_URL = f"https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz"
ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True, help="new or empty build/evidence directory")
    source_args = parser.add_mutually_exclusive_group(required=True)
    source_args.add_argument("--source", type=Path, help="official source tarball with the pinned checksum")
    source_args.add_argument("--download", action="store_true", help="explicitly download the pinned official source")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--extra-cflags", default="")
    parser.add_argument("--extra-ldflags", default="")
    args = parser.parse_args()
    if args.jobs < 1 or args.jobs > 16:
        parser.error("--jobs must be between 1 and 16")
    output = args.output_dir.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Output directory must be new or empty")
    for tool in ("make", "pkg-config", "patch"):
        if not shutil.which(tool):
            parser.error(f"Missing build tool: {tool}")
    for library in ("gnutls", "x264", "opus", "libxml-2.0"):
        if subprocess.run(["pkg-config", "--exists", library]).returncode:
            parser.error(f"Missing development library {library}; check PKG_CONFIG_PATH")
    output.mkdir(parents=True, exist_ok=True)
    source = output / f"ffmpeg-{VERSION}.tar.xz"
    if args.download:
        print(f"Downloading {SOURCE_URL}", flush=True)
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response, source.open("xb") as target:
            while True:
                data = response.read(1024 * 1024)
                if not data:
                    break
                target.write(data)
    else:
        shutil.copyfile(args.source, source)
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Official source checksum mismatch; refusing to compile")
    with tarfile.open(source) as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != f"ffmpeg-{VERSION}":
                raise RuntimeError("Unsafe source archive path")
            if not member.isdir() and not member.isfile():
                raise RuntimeError("Unexpected source archive link or special file")
        if hasattr(tarfile, "data_filter"):
            archive.extractall(output, filter="data")
        else:
            archive.extractall(output)
    tree = output / f"ffmpeg-{VERSION}"
    patch = ROOT / f"packaging/media-helper/ffmpeg-{VERSION}-tls-options.patch"
    with patch.open("rb") as changes:
        subprocess.run(["patch", "--batch", "--forward", "-p1"], stdin=changes, cwd=tree, check=True)
    runtime = output / "runtime"
    configure = [str(tree / "configure"), f"--prefix={runtime}", "--extra-version=ldm-tls1", "--disable-autodetect",
        "--enable-gnutls", "--enable-libx264", "--enable-libmp3lame", "--enable-libopus", "--enable-libxml2",
        "--enable-gpl", "--disable-doc", "--disable-debug", "--disable-ffplay"]
    if args.extra_cflags:
        configure.append("--extra-cflags=" + args.extra_cflags)
    if args.extra_ldflags:
        configure.append("--extra-ldflags=" + args.extra_ldflags)
    commands = [("configure", configure), ("compile", ["make", "-j", str(args.jobs)]), ("install", ["make", "install"])]
    for name, command in commands:
        print(f"Running {name}; log: {output / (name + '.log')}", flush=True)
        with (output / f"{name}.log").open("w") as log:
            result = subprocess.run(command, cwd=tree, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f"{name} failed; see {name}.log")
    info = {"version": VERSION, "revision": "ldm-tls1", "platform": platform.system(), "architecture": platform.machine(),
        "source_url": SOURCE_URL, "source_sha256": SOURCE_SHA256,
        "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "configure": configure,
        "license": "GPL version 2 or later; third-party dependency licenses also apply", "qualified": False, "binaries": {}}
    for name in ("ffmpeg", "ffprobe"):
        binary = runtime / "bin" / name
        info["binaries"][name] = {"sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "version": subprocess.check_output([str(binary), "-version"], text=True).splitlines()[0]}
    documentation = runtime / "share/doc/ldm-media-helper"
    documentation.mkdir(parents=True)
    shutil.copyfile(tree / "COPYING.GPLv2", documentation / "COPYING.GPLv2")
    shutil.copyfile(source, documentation / source.name)
    shutil.copyfile(patch, documentation / patch.name)
    shutil.copyfile(Path(__file__), documentation / "build_media_helper.py")
    (runtime / "BUILD-INFO.json").write_text(json.dumps(info, indent=2) + "\n")
    print(f"Built helpers in {runtime / 'bin'}. Strict LDM TLS qualification is still required.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
