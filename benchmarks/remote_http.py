#!/usr/bin/env python3
"""Measure an explicitly supplied small HTTP(S) file with LDM 1 vs 8 connections.

HEAD must advertise a positive Content-Length below --max-mib before an engine
transfer can start. Temporary downloads are removed. No competitor is launched.
"""

import argparse
import json
import os
import platform
import re
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from local_http import MIB, file_digest


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise ValueError("The benchmark URL and every redirect must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials in benchmark URLs are unsupported")
    if parsed.path.lower().endswith((".m3u8", ".mpd")):
        raise ValueError("Use a direct test file, not an HLS/DASH manifest")
    return url


def public_url(url):
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, request, _fp, _code, _message, _headers, newurl):
        validate_url(newurl)
        # Preserve HEAD on redirects so preflight cannot become a full GET.
        return urllib.request.Request(newurl, method=request.get_method(), headers=dict(request.headers))


def preflight(opener, url, maximum, timeout):
    headers = {"User-Agent": "LDM-benchmark/1.0", "Accept-Encoding": "identity", "Cache-Control": "no-cache"}
    request = urllib.request.Request(validate_url(url), method="HEAD", headers=headers)
    with opener.open(request, timeout=timeout) as response:
        length = response.headers.get("Content-Length", "")
        if not re.fullmatch(r"[0-9]+", length) or not 0 < int(length) <= maximum:
            raise ValueError(f"HEAD must advertise 1..{maximum} bytes; received {length or 'unknown size'}")
        final_url = validate_url(response.geturl())
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type in ("application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml", "text/html"):
            raise ValueError("Benchmark requires a direct binary test file, not a manifest or HTML page")
        if response.headers.get("Content-Encoding", "identity").lower() not in ("", "identity"):
            raise ValueError("Compressed content makes the byte cap ambiguous; use an uncompressed test file")
        metadata = {"content_length": int(length), "content_type": content_type,
                    "etag": response.headers.get("ETag", ""),
                    "last_modified": response.headers.get("Last-Modified", ""),
                    "accept_ranges_header": response.headers.get("Accept-Ranges", ""),
                    "source_url": public_url(final_url), "query_omitted": bool(urllib.parse.urlsplit(final_url).query)}
    probe_headers = dict(headers, Range="bytes=0-0")
    with opener.open(urllib.request.Request(final_url, headers=probe_headers), timeout=timeout) as response:
        # Read one byte only, including when the server ignores Range.
        first_byte = response.read(1)
        metadata["range_probe_status"] = response.status
        metadata["range_probe_bytes_read"] = len(first_byte)
        metadata["range_probe_content_range"] = response.headers.get("Content-Range", "")
        metadata["range_verified"] = (response.status == 206 and first_byte != b""
                                       and response.headers.get("Content-Range", "").lower()
                                       == f"bytes 0-0/{metadata['content_length']}")
    return final_url, headers, metadata


def report_markdown(report):
    source = report["source"]
    lines = ["# LDM remote HTTP measurement", "", f"Recorded: {report['recorded_utc']}", "",
             f"Source: {source['source_url']}", f"HEAD size: {source['content_length']:,} bytes; configured cap: {report['maximum_bytes']:,} bytes per trial.",
             f"Byte range probe verified: {source['range_verified']} (HTTP {source['range_probe_status']}).", "",
             "| Connections requested | Median seconds | Median MiB/s | All bytes/hashes correct |",
             "| --- | ---: | ---: | --- |"]
    for summary in report["summary"]:
        lines.append(f"| {summary['connections']} | {summary['median_seconds']:.3f} | {summary['median_mib_per_second']:.2f} | {summary['all_correct']} |")
    lines += ["", f"Observed file SHA-256: `{report['observed_sha256']}`.",
              f"Executable SHA-256: `{report['executable_sha256']}`.",
              f"Host: {report['environment']['platform']}; Python {report['environment']['python']}.", "",
              "These are measurements of this source and network at this time. Timings include",
              "metadata probing, network setup, transfer and local output assembly. Server/CDN",
              "caches, routing, rate limits, shared bandwidth and trial order affect results.",
              "Requested connection counts are recorded; actual sockets are not observed here.",
              "If the source ignores ranges, LDM falls back to a sequential request; neither",
              "a range header nor this report guarantees use of eight simultaneous connections.",
              "No IDM/XDM measurement was performed. This evidence cannot establish that LDM is",
              "the fastest downloader. Query parameters are omitted from saved source URLs.",
              "All payloads were temporary and removed after verification.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path, nargs="?", help="LDM binary; omitted only for --preflight-only")
    parser.add_argument("--url", required=True, help="explicit HTTP(S) URL of a small public binary test file")
    parser.add_argument("--max-mib", type=int, default=16, help="maximum advertised bytes per trial, 1..32 MiB")
    parser.add_argument("--repetitions", type=int, default=2, help="1..3 alternating trials for each of 1 and 8 connections")
    parser.add_argument("--timeout", type=int, default=30, help="5..120 seconds per download")
    parser.add_argument("--expected-sha256", help="optional independently known file SHA-256")
    parser.add_argument("--output-dir", type=Path, help="new or empty evidence directory; required for timed measurements")
    parser.add_argument("--preflight-only", action="store_true", help="HEAD plus one-byte range probe; no engine process or payload download")
    args = parser.parse_args()
    if not 1 <= args.max_mib <= 32 or not 1 <= args.repetitions <= 3 or not 5 <= args.timeout <= 120:
        parser.error("Expected max-mib 1..32, repetitions 1..3 and timeout 5..120")
    if args.expected_sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", args.expected_sha256):
        parser.error("Expected SHA-256 must contain exactly 64 hexadecimal characters")
    if not args.preflight_only:
        if not args.executable or not args.output_dir:
            parser.error("A timed measurement requires an LDM executable and --output-dir")
        executable = args.executable.resolve()
        if not executable.is_file() or not os.access(executable, os.X_OK):
            parser.error("Executable must be an existing runnable LDM binary")
        output = args.output_dir.resolve()
        if output.exists() and any(output.iterdir()):
            parser.error("Evidence directory must be empty; existing results are never replaced")
    maximum = args.max_mib * MIB
    remote = urllib.request.build_opener(SafeRedirect())
    # No engine subprocess or download exists until HEAD and size checks pass.
    final_url, _headers, metadata = preflight(remote, args.url, maximum, min(args.timeout, 15))
    if args.preflight_only:
        print(json.dumps({"preflight_only": True, "maximum_bytes": maximum, "source": metadata,
                          "engine_started": False, "payload_saved": False}, indent=2))
        return 0
    print(f"Preflight accepted {metadata['content_length']:,} bytes; ranges verified={metadata['range_verified']}", flush=True)
    if not metadata["range_verified"]:
        print("Source did not verify byte ranges: sequential fallback is expected; no multi-connection speed claim.", flush=True)
    expected_hash = args.expected_sha256.lower() if args.expected_sha256 else None
    report = {"schema_version": 1, "recorded_utc": datetime.now(timezone.utc).isoformat(),
              "scope": "Caller-supplied remote HTTP(S) file; LDM configuration comparison only",
              "maximum_bytes": maximum, "repetitions": args.repetitions, "source": metadata,
              "executable_sha256": file_digest(executable), "observed_sha256": None,
              "independent_sha256_provided": bool(args.expected_sha256),
              "environment": {"platform": platform.platform(), "architecture": platform.machine(),
                              "python": platform.python_version(), "cpu_count": os.cpu_count(),
                              "proxy_environment_present": any(os.environ.get(name) for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"))},
              "competitor_measurement": False, "trials": [], "summary": []}
    local = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    def cancel(job_id):
        try:
            request = urllib.request.Request(base + "/api/cancel", data=json.dumps({"id": job_id}).encode(),
                                             headers={"Content-Type": "application/json"})
            local.open(request, timeout=2).close()
        except OSError:
            pass

    with tempfile.TemporaryDirectory(prefix="ldm-remote-benchmark-") as temporary:
        work = Path(temporary)
        with (work / "engine.log").open("w") as log:
            process = subprocess.Popen([str(executable), "--server", str(port)], cwd=work, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with local.open(base + "/api/health", timeout=0.2):
                            break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError("LDM exited during remote measurement startup")
                        time.sleep(0.05)
                else:
                    raise RuntimeError("LDM service did not start")
                for repetition in range(1, args.repetitions + 1):
                    # Revalidate the remote file before every pair of trials.
                    trial_url, trial_headers, current = preflight(remote, final_url, maximum, min(args.timeout, 15))
                    if current["content_length"] != metadata["content_length"]:
                        raise RuntimeError("Remote Content-Length changed; refusing inconsistent measurements")
                    for count in (1, 8):
                        job_id = f"remote-benchmark-{repetition}-{count}"
                        destination = work / f"trial-{repetition}-{count}.bin"
                        if current["etag"] and not current["etag"].startswith("W/"):
                            trial_headers["If-Match"] = current["etag"]
                        elif current["last_modified"]:
                            trial_headers["If-Unmodified-Since"] = current["last_modified"]
                        task = {"id": job_id, "url": trial_url, "output_path": str(destination),
                                "max_connections": count, "headers": trial_headers}
                        request = urllib.request.Request(base + "/download", data=json.dumps(task).encode(),
                                                         headers={"Content-Type": "application/json"})
                        started = time.perf_counter()
                        completed = False
                        try:
                            with local.open(request, timeout=args.timeout) as response:
                                for line in response:
                                    event = json.loads(line)
                                    if event.get("event") == "error":
                                        raise RuntimeError(f"LDM download failed: {event.get('message', 'engine error')}")
                                    if max(event.get("bytes_downloaded", 0), event.get("total_bytes", 0), event.get("bytes_processed", 0)) > maximum:
                                        raise RuntimeError("Remote transfer exceeded its expected byte cap")
                                    if time.perf_counter() - started > args.timeout:
                                        raise TimeoutError("Remote download exceeded its time limit")
                                    completed |= event.get("event") == "completed"
                        except Exception:
                            cancel(job_id)
                            raise
                        elapsed = time.perf_counter() - started
                        actual_bytes = destination.stat().st_size if destination.is_file() else 0
                        if not completed or actual_bytes != metadata["content_length"]:
                            raise RuntimeError("Remote output did not complete at the advertised byte count")
                        digest = file_digest(destination)
                        if expected_hash is None:
                            expected_hash = digest
                        if digest != expected_hash:
                            raise RuntimeError("Remote output SHA-256 changed or failed the independent checksum")
                        trial = {"connections": count, "repetition": repetition, "seconds": elapsed,
                                 "bytes": actual_bytes, "sha256": digest, "correct": True,
                                 "mib_per_second": actual_bytes / elapsed / MIB,
                                 "range_probe_verified": current["range_verified"]}
                        report["trials"].append(trial)
                        print(f"{count} requested connections, trial {repetition}: {trial['mib_per_second']:.2f} MiB/s; {elapsed:.3f}s; SHA-256 consistent", flush=True)
                        destination.unlink()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
    report["observed_sha256"] = expected_hash
    for count in (1, 8):
        trials = [trial for trial in report["trials"] if trial["connections"] == count]
        report["summary"].append({"connections": count, "median_seconds": statistics.median(trial["seconds"] for trial in trials),
                                  "median_mib_per_second": statistics.median(trial["mib_per_second"] for trial in trials),
                                  "all_correct": all(trial["correct"] for trial in trials)})
    output.mkdir(parents=True, exist_ok=True)
    with (output / "results.json").open("x") as content:
        content.write(json.dumps(report, indent=2) + "\n")
    with (output / "REPORT.md").open("x") as content:
        content.write(report_markdown(report))
    print(f"Saved remote measurement evidence: {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(f"Remote measurement stopped: {error}")
