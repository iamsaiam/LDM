#!/usr/bin/env python3
"""Build development release artifacts, refusing to replace existing files."""

import argparse
import gzip
import hashlib
import json
import os
import platform
import re
import stat
import subprocess
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRECTORIES = ("cpp-engine", "desktop-ui", "extension", "backend", "packaging", "scripts", "benchmarks", ".github")
SOURCE_FILES = ("LICENSE", "README.md", "PROGRESS.md", "RELEASE.md", ".gitignore")
EXCLUDED_COMPONENTS = {".git", ".venv", "venv", "node_modules", "__pycache__", "CMakeFiles", "Testing", "downloads", "dist", "artifacts", "results"}
SOURCE_SUFFIXES = {".cpp", ".h", ".in", ".py", ".js", ".cjs", ".css", ".html", ".json", ".svg", ".webmanifest", ".md", ".yml", ".yaml", ".desktop", ".sh", ".txt", ".patch", ".icns"}


def source_paths():
    for name in SOURCE_FILES:
        path = ROOT / name
        if path.is_file() and not path.is_symlink():
            yield path
    for directory in SOURCE_DIRECTORIES:
        for path in sorted((ROOT / directory).rglob("*")):
            components = path.relative_to(ROOT).parts
            if (not path.is_file() or path.is_symlink()
                    or any(part in EXCLUDED_COMPONENTS or part.startswith(".env") for part in components)
                    or any(part.startswith("build") for part in components[:-1])
                    or path.suffix not in SOURCE_SUFFIXES):
                continue
            yield path


def zip_artifact(destination, members, epoch):
    """Member tuples are archive name, bytes, mode; ordering and metadata are stable."""
    stamp = time.gmtime(max(315532800, min(epoch, 4354819198)))[:6]
    with destination.open("xb") as output:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data, mode in sorted(members):
                info = zipfile.ZipInfo(name, stamp)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)


def extension_members(browser):
    extension = ROOT / "extension"
    manifest_path = extension / ("manifest.firefox.json" if browser == "firefox" else "manifest.json")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected a Manifest V3 extension")
    members = []
    for path in sorted(extension.rglob("*")):
        relative = path.relative_to(extension)
        if (not path.is_file() or path.is_symlink() or "tests" in relative.parts
                or any(part.startswith(".") for part in relative.parts)
                or path.name in ("manifest.json", "manifest.firefox.json")):
            continue
        if path.suffix not in {".js", ".css", ".html", ".svg", ".png", ".json"}:
            continue
        members.append((relative.as_posix(), path.read_bytes(), 0o644))
    members += [("manifest.json", manifest_path.read_bytes(), 0o644),
                ("LICENSE", (ROOT / "LICENSE").read_bytes(), 0o644)]
    names = {name for name, _, _ in members}
    background = manifest.get("background", {})
    referenced = list(background.get("scripts", []))
    if background.get("service_worker"):
        referenced.append(background["service_worker"])
    if manifest.get("action", {}).get("default_popup"):
        referenced.append(manifest["action"]["default_popup"])
    for content in manifest.get("content_scripts", []):
        referenced.extend(content.get("js", []))
        referenced.extend(content.get("css", []))
    missing = set(referenced) - names
    if missing:
        raise ValueError(f"Extension references missing files: {sorted(missing)}")
    return manifest["version"], members


def native_artifact(destination, build_directory, version, epoch):
    host = platform.system()
    expected = build_directory / ("LDM.app/Contents/MacOS/LDM" if host == "Darwin" else "ldm-downloader")
    if not expected.is_file():
        raise ValueError(f"No native {host} build found at {expected}")
    with tempfile.TemporaryDirectory(prefix="ldm-package-stage-") as temporary:
        stage = Path(temporary)
        subprocess.run(["cmake", "--install", str(build_directory), "--prefix", str(stage)], check=True)
        (stage / "RELEASE.md").write_bytes((ROOT / "RELEASE.md").read_bytes())
        metadata = {"version": version, "platform": host, "architecture": platform.machine(),
                    "ffmpeg_bundled": False, "signing": "unsigned", "portable": False,
                    "notes": "Native development package. System libcurl and FFmpeg/ffprobe required; see RELEASE.md."}
        (stage / "BUILD-INFO.json").write_text(json.dumps(metadata, indent=2) + "\n")
        with destination.open("xb") as output:
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=epoch) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for path in sorted(stage.rglob("*")):
                        info = archive.gettarinfo(str(path), arcname=f"LDM-{version}/{path.relative_to(stage).as_posix()}")
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        info.mtime = epoch
                        if info.isfile():
                            with path.open("rb") as content:
                                archive.addfile(info, content)
                        else:
                            archive.addfile(info)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("source", "extensions", "native", "all"), required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="must be a new or empty directory")
    parser.add_argument("--build-dir", type=Path, help="configured native Release build, needed for native/all")
    parser.add_argument("--dry-run", action="store_true", help="list artifacts and inputs without creating archives")
    args = parser.parse_args()
    match = re.search(r"\bVERSION\s+([0-9]+\.[0-9]+\.[0-9]+)", (ROOT / "cpp-engine/CMakeLists.txt").read_text())
    if not match:
        parser.error("Cannot read project version from CMakeLists.txt")
    version = match[1]
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "315532800"))
    if not 0 <= epoch <= 4354819198:
        parser.error("SOURCE_DATE_EPOCH must fit the supported ZIP/tar timestamp range")
    output = args.output_dir.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Output directory must be empty; existing files are never replaced")
    kinds = {"source", "extensions", "native"} if args.kind == "all" else {args.kind}
    plan = []
    if "source" in kinds:
        paths = list(source_paths())
        plan.append((f"ldm-{version}-source.zip", "source", paths))
    if "extensions" in kinds:
        for browser in ("chromium", "firefox"):
            extension_version, members = extension_members(browser)
            plan.append((f"ldm-extension-{extension_version}-{browser}.zip", "extension", members))
    if "native" in kinds:
        if not args.build_dir or platform.system() not in ("Linux", "Darwin"):
            parser.error("Native packaging requires --build-dir on Linux or macOS")
        plan.append((f"ldm-{version}-{platform.system().lower()}-{platform.machine()}.tar.gz", "native", []))
    for filename, kind, members in plan:
        print(f"{output / filename}: {kind}, {len(members) if kind != 'native' else 'staged native'} inputs")
    if args.dry_run:
        print("Dry run only; no output created.")
        return 0
    output.mkdir(parents=True, exist_ok=True)
    for filename, kind, members in plan:
        destination = output / filename
        if kind == "source":
            zip_artifact(destination, [(f"LDM-{version}/{path.relative_to(ROOT).as_posix()}", path.read_bytes(),
                                       0o755 if path.stat().st_mode & 0o111 else 0o644) for path in members], epoch)
        elif kind == "extension":
            zip_artifact(destination, members, epoch)
        else:
            native_artifact(destination, args.build_dir.resolve(), version, epoch)
    with (output / "SHA256SUMS").open("x") as checksums:
        for filename, _, _ in plan:
            digest = hashlib.sha256((output / filename).read_bytes()).hexdigest()
            checksums.write(f"{digest}  {filename}\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Packaging failed: {error}")
