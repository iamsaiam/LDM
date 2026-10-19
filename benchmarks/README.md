# Reproducible local HTTP measurement

`local_http.py` starts its own HTTP fixture and LDM service on random loopback
ports. It uses a 32 MiB deterministic payload by default, supports byte ranges,
provides an ETag, and requests 1 and 8 engine connections in alternating trials.
It never contacts a public server, launches a browser, or changes XDM settings.

Build a Release binary first. Run from the project root on Linux:

```sh
python3 benchmarks/local_http.py /tmp/ldm-release-build/ldm-downloader \
  --size-mib 32 --repetitions 3 --output-dir benchmarks/results/uncapped
python3 benchmarks/local_http.py /tmp/ldm-release-build/ldm-downloader \
  --size-mib 32 --repetitions 3 --per-connection-mib 8 \
  --output-dir benchmarks/results/per-response-8mib
```

On macOS, pass `build-release/LDM.app/Contents/MacOS/LDM` as the executable.
Python 3.9 or newer and permission to bind/connect to loopback are required. A
permission error is an environment restriction; it is not a download result.
An existing results directory must be empty, so previous evidence cannot be
silently replaced. Downloads and the fixture exist only in a temporary directory
and are removed after each run. Payloads are capped at 256 MiB.

Each trial records elapsed wall time, downloaded bytes, SHA-256, requested
connection count, observed concurrent responses, request counts and throughput.
Timing includes API setup, metadata/range probing, transfer and output assembly.
Payload creation and hash verification are outside the timed interval. The report
includes executable SHA-256 and host details so it can be tied to a build.
Fixture revision 2 also records the fixture script SHA-256 and a listening backlog
of 64 connections. This avoids the stdlib's default listen queue becoming a source
of connection-start delays when eight workers connect together.
Output integrity failures stop the run. Values use MiB/s (1 MiB = 1,048,576 bytes).

The uncapped case measures the local fixture, CPU, memory, OS cache and disk.
The capped case models a server limiting each response independently and
deliberately favors multiple connections. A real server may enforce a total
bandwidth cap, ignore ranges, or slow clients that open many connections. Multiple
connections cannot exceed the available network and server capacity.

These reports compare LDM configurations. They do **not** compare LDM against
IDM/XDM, measure Internet speed, or prove that LDM is the fastest downloader.
If a comparator is installed, the report records its executable path only.
A proper comparison needs the same URL, output integrity check, connection cap,
network conditions, fresh output and repeated alternating runs for each program.
The installed XDM package on the development host requires its GUI/profile for
downloads; no documented headless benchmark interface was found in its local
distribution, so it has not been launched or measured by this script.

## Initial fixture results and revision 2

The original evidence under `results/per-response-8mib` and `results/uncapped`
is preserved. Those runs used Python 3.14's default listen backlog of 5. Their
32 MiB capped medians were approximately 7.77 MiB/s with one connection and
19.58 MiB/s with eight connections. In the uncapped eight-connection run, two
trials took approximately 0.190 and 0.181 seconds; a third took 1.171 seconds
and observed only five concurrent responses. All byte/hash checks passed.

The small listen queue is a plausible cause of connection-start delays and the
outlier; no packet trace was recorded to prove a SYN retransmission. Revision 2
sets a backlog of 64 and records the fixture configuration. Fresh measurements
must go into different directories, for example `results/uncapped-backlog64` and
`results/per-response-8mib-backlog64`. This is a fixture correction, not an engine
optimization or evidence that LDM became faster. Keep the old data alongside the
new results and compare build hashes and measurement conditions.

The completed revision-2 runs on 2026-10-17 used a 32 MiB fixture and three
alternating repetitions for each configuration. All 12 output hashes/byte counts
matched. Exact timings and individual trials remain in the linked evidence:

| Fixture | 1 connection median | 8 connections median | Evidence |
| --- | ---: | ---: | --- |
| Per-response 8 MiB/s cap | 7.821185 MiB/s; 4.091452 s | 53.741040 MiB/s; 0.595448 s | [report](../docs/benchmarks/per-response-8mib-backlog64/REPORT.md), [JSON](../docs/benchmarks/per-response-8mib-backlog64/results.json) |
| Uncapped loopback | 310.054602 MiB/s; 0.103208 s | 369.692400 MiB/s; 0.086558 s | [report](../docs/benchmarks/uncapped-backlog64/REPORT.md), [JSON](../docs/benchmarks/uncapped-backlog64/results.json) |

Both revised runs used executable SHA-256
`00db57609bd6409f5b47fcc4577b452a415320ad6868a3e7a2bc32975609f2ef`
and fixture script SHA-256
`cd155b32340240ec40addfc18f4f286a14bc6bf2135ec2b6f331ee7e953280b0`.
The 33,554,432-byte payload SHA-256 was
`c5febe7f44faea048a51663faa8228bb80c76b606644caf5accc5c04b858fdf9`.
The earlier run used executable
`dc0babdbc68b6a2f576c39dae54c62a356592e1864706c514a5c7ea521668032`,
so a comparison with those runs changes both fixture and application build.
The numbers cannot isolate an engine optimization. These remain local synthetic
measurements; no Internet or competitor speed claim follows from them. Generated reports remain outside source packaging. The archived reports linked
above are included under `docs/benchmarks/` so the published evidence is reviewable.

## Optional bounded remote HTTP measurement

`remote_http.py` takes an explicit URL of a small public binary test file. It
requires a positive HEAD Content-Length below the cap **before** starting an
engine transfer, rejects unknown sizes, manifests, HTML and encoded responses,
preserves HEAD across HTTP(S) redirects, and checks byte-range behavior with a
one-byte probe. TLS verification remains enabled. No URL is chosen automatically.

Run a source preflight without starting LDM or saving a payload:

```sh
python3 benchmarks/remote_http.py --url "$LDM_BENCHMARK_URL" \
  --max-mib 16 --timeout 15 --preflight-only
```

Set `LDM_BENCHMARK_URL` to a verified HTTP(S) test-file URL first. Preflight sends
HEAD, then requests and reads at most one body byte if the size is accepted. If
HEAD has an unknown size, is over the cap, or fails, it makes no data GET. A 429,
TLS error, refusal, or disconnect stops the command; no alternate endpoint or
protection bypass is attempted automatically.

```sh
python3 benchmarks/remote_http.py /tmp/ldm-release-build/ldm-downloader \
  --url 'https://YOUR-VERIFIED-TEST-HOST/small-test-file.bin' \
  --max-mib 16 --repetitions 2 --timeout 30 \
  --output-dir benchmarks/results/remote-http
```

Replace the placeholder with a verified test-file URL. `--max-mib` is an expected
per-trial cap (default 16 MiB, at most 32 MiB). There are two configurations per
repetition, so defaults transfer at most about 64 MiB of payload plus probes and
retries when the server honors its advertised length. Metadata is revalidated
between repetitions; progress exceeding the cap triggers cancellation. A remote
server changing its response after HEAD is outside this preflight guarantee.
Use a trusted test endpoint. `--expected-sha256` can supply an independently known
checksum; otherwise every trial must match the first observed file hash and size.

Downloads stay in temporary storage and are removed. Saved evidence includes
source URL without query parameters, timestamps, size, range-probe result,
executable hash, host details, per-trial times and median throughput. Requested
connection counts do not measure actual simultaneous sockets. A server that
ignores ranges is reported as sequential fallback, with no multi-connection speed
claim. Network/CDN conditions can change between runs. No IDM/XDM process or
profile is used, so these measurements do not establish competitor superiority.


## Recorded external HTTPS check

On 2026-10-19 (Asia/Dhaka), the native Linux engine downloaded the official
12,040,788-byte FFmpeg 9.0.2 source archive with TLS verification enabled.
The size preflight and one-byte range probe passed. One trial requested one
connection (6.743 seconds, 1.70 MiB/s); one requested eight connections
(6.331 seconds, 1.81 MiB/s). Both matched the pinned official source SHA-256.

See the [report](../docs/benchmarks/remote-ffmpeg-2026-10-19/REPORT.md) and
[raw measurements](../docs/benchmarks/remote-ffmpeg-2026-10-19/results.json).
These two trials verify the recorded downloads. Trial order and changing network
conditions prevent a general parallel-speed conclusion. No competitor was measured.


## Fixture revision 3

The current loopback server starts without reverse DNS and sets TCP_NODELAY on
accepted fixture connections. This keeps startup independent of runner DNS and
avoids measuring small-write coalescing in the source server. New CI reports
identify revision 3. The archived revision-2 results and their original hashes
remain unchanged; comparisons must account for the fixture revision.
