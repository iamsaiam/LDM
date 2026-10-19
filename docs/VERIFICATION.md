# Verification record

Updated: **2026-10-19** (Asia/Dhaka). Results below identify the code and environment
that were actually exercised. The live workflow badge in the README shows the
latest build status.

## Native CI

Repository: [iamsaiam/LDM](https://github.com/iamsaiam/LDM).

| Platform | Current qualified build |
| --- | --- |
| Ubuntu 24.04 x86_64 | 15/15 CTest groups in 41.98 s; 38/38 JavaScript cases; native install, strict TLS, benchmark and packages passed |
| Apple Silicon macOS 15 | 15/15 CTest groups in 44.36 s; 38/38 JavaScript cases; native install, strict TLS, benchmark and packages passed |
| Intel macOS 15 | 15/15 CTest groups in 48.36 s; 38/38 JavaScript cases; native install, strict TLS, benchmark and packages passed |

Current tested source: `7b09aa19841966253ce40c15207bb0ed3da85210`.
[Qualification run 39216049220](https://github.com/iamsaiam/LDM/actions/runs/39216049220).
The final source documentation commit is recorded separately in the bundle's
`VERIFICATION.json`; documentation changes preserve the tested engine and UI code.

The initial source commit is `02538a677f3edd1bf3327d084e84a864c8f0c1eb`.
The first run exposed Apple C++ library support for `std::jthread` and a missing
Homebrew LAME include/library search path on Apple Silicon. Commit
`c05d8ef4bb96da917adbff6f04da866ef3c48429` replaces the worker ownership with joined
`std::thread` instances and supplies the Homebrew search path. Its follow-up run is
[available here](https://github.com/iamsaiam/LDM/actions/runs/39157780133).
That run passed Linux. Mac diagnostics later traced fixture stalls to reverse
DNS during server startup and traced certificate failures to runner-specific
OpenSSL defaults. Explicit fixture server names and certificate configuration
resolved those setup dependencies. Fixture throttling now uses elapsed time to
avoid accumulating operating-system sleep overshoot. Commit `e8bd06942e1ff804c64ef2908b8d4b7a006719ba`
gives each libcurl shared-data kind a separate mutex, as required by the
[libcurl callback API](https://curl.se/libcurl/c/CURLSHOPT_LOCKFUNC.html), and
qualifies the Homebrew libcurl build on Mac using `CURL_ROOT`. Its native run is
[39158652225](https://github.com/iamsaiam/LDM/actions/runs/39158652225).

Native checks cover file reservation, job registry, HTTP reconnect/fallback,
pause/resume/cancellation, media selection, progress backpressure, FTP, HTTPS/FTPS
trust and integrity, helper TLS policy, and dashboard/extension logic. JavaScript
cases are also included in a CTest group; the counts overlap.

The installation check stages a fresh prefix, checks executable hashes and
permissions, starts the installed native executable, serves the dashboard,
downloads exact fixture bytes, and verifies a real HLS-to-MKV output with audio.
On Mac it also checks Mach-O architecture, bundle metadata/icon, linked libraries
and helper discovery with a Finder-style `PATH`. Automated process launch does not
establish interactive Finder/Gatekeeper behavior on a clean consumer Mac.

## Installed browser verification

Generated localhost media was used with fresh temporary profiles on Linux:

| Browser | Version | Record |
| --- | --- | --- |
| Google Chrome | 155.0.8059.39 | [Passed](verification/chrome-live.json) |
| Chromium | 151.0.7922.34 | [Passed](verification/chromium-live.json) |
| Firefox | 158.0 | [Passed](verification/firefox-live.json) |

Checks exercised actual extension installation, native-player/network discovery,
Cookie/Referer-authenticated downloads with exact SHA-256, overlay Pause/Resume/
Cancel, 180p/360p HLS inspection and a selected 360p MKV with AAC audio, popup MP3
extraction, and history recovery after an extension worker/runtime restart.

Popup documents were exercised as extension pages in browser tabs. Toolbar popup
window geometry and the operating system's notification display were not measured.
The Chrome reports retain a harmless missing fixture favicon response. Chromium's
sandbox exception was explicitly authorized for these isolated generated local
fixtures. Firefox used temporary installation and browser-UI access in a separate
profile. Personal browser profiles were not used.

See [repeatable browser checks](../scripts/browser-tests/README.md). These results
cover the generated fixtures; representative external sites and authentication
expiry need source-specific verification.

## Media trust

The selected helper is official FFmpeg **9.0.2** with the included TLS inheritance
patch. Source SHA-256:
`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`.
The original source was checked against FFmpeg's release signing key. The builder
checks that pinned source digest for subsequent builds.

Strict local fixtures require successful private-CA HLS/DASH and AES-128 HLS
processing, and rejection of wrong-host media segments and encryption keys.
Native HTTPS/FTPS checks include encrypted FTP data, one/four-connection hashes,
unknown CA rejection and hostname rejection. FFmpeg 8.0.1 failed the nested trust
check; release builds reject helpers with disabled or unavailable TLS defaults.

## Performance

[Archived benchmark records](../benchmarks/README.md) include the original
small-backlog measurements and corrected fixture revision 2. All recorded outputs
matched their expected size and SHA-256. The corrected capped 32 MiB fixture had
medians of 7.82 MiB/s (one connection) and 53.74 MiB/s (eight connections). The
server capped each response independently, favoring parallel ranges.

A separate [external HTTPS check](benchmarks/remote-ffmpeg-2026-10-19/REPORT.md)
on 2026-10-19 downloaded FFmpeg's official 12,040,788-byte source archive with one
and eight requested connections. Both matched the known source digest. The two
single trials measured 1.70 and 1.81 MiB/s respectively. They identify one source
and network at that time; no controlled IDM/XDM comparison has been completed.

## Distribution scope

Native packages require compatible system libraries and media helpers. Mac builds
are unsigned and unnotarized. Firefox permanent installation requires Mozilla
signing; the checked ZIP uses temporary developer installation. Browser store
submission, interactive clean-host desktop checks and broader site coverage remain
separate from automated native verification. No signing credentials are included.
