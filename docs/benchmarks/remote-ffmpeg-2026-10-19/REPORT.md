# LDM remote HTTP measurement

Recorded: 2026-10-18T19:27:02.815252+00:00

Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
HEAD size: 12,040,788 bytes; configured cap: 16,777,216 bytes per trial.
Byte range probe verified: True (HTTP 206).

| Connections requested | Median seconds | Median MiB/s | All bytes/hashes correct |
| --- | ---: | ---: | --- |
| 1 | 6.743 | 1.70 | True |
| 8 | 6.331 | 1.81 | True |

Observed file SHA-256: `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`.
Executable SHA-256: `15b16e788a3f0ad5c556f565cdbaa38bdf601110a9b7dad2e9c1205edb5f5c01`.
Host: Linux-7.0.0-38-generic-x86_64-with-glibc2.43; Python 3.14.4.

These are measurements of this source and network at this time. Timings include
metadata probing, network setup, transfer and local output assembly. Server/CDN
caches, routing, rate limits, shared bandwidth and trial order affect results.
Requested connection counts are recorded; actual sockets are not observed here.
If the source ignores ranges, LDM falls back to a sequential request; neither
a range header nor this report guarantees use of eight simultaneous connections.
No IDM/XDM measurement was performed. This evidence cannot establish that LDM is
the fastest downloader. Query parameters are omitted from saved source URLs.
All payloads were temporary and removed after verification.
