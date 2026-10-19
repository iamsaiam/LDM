# Implementation and release status

LDM means **Local Download Manager**. The project targets Linux and macOS with a
native C++20/libcurl engine, an embedded browser dashboard/PWA and browser
extensions for Chromium and Firefox.

## Implemented

| Area | Behavior |
| --- | --- |
| Direct transfers | HTTP/HTTPS, FTP/FTPS according to libcurl capabilities; verified ranges, parallel workers, retry/fallback and validated partial reuse |
| File integrity | Output reservations, numbered names for collisions, exact byte/hash integration checks and cancellation cleanup |
| Controls | Pause, Resume and Cancel in the dashboard, popup and player overlay; paused jobs preserve their engine identity |
| Progress | Direct-file bytes, total, rate and ETA; streaming output bytes and processing progress |
| Media | HLS/DASH inspection, actual quality/audio tracks, MP4/MKV output and M4A/MP3/Opus audio-only processing |
| Discovery | Network responses, native player sources, embedded frames, extensionless media and playlist hints |
| Recovery | Browser-session queue recovery and reconciliation with jobs that remain active in the engine |
| Privacy | Persistent history contains metadata; source URLs and identity headers stay in temporary/session state until a selected transfer |
| Packaging | Native install layouts, separate browser packages, full source archive, sources/licenses for the pinned helper and SHA-256 records |

Downloads normally use the user's Downloads directory; `LDM_DOWNLOAD_DIR` and the
dashboard's absolute save-folder field can select another location. Pausing keeps
the current engine process alive. It does not preserve an active job across engine
shutdown. Validated direct range chunks can be reused when the remote identity
still matches.

## Qualification

Current tested source: `7b09aa19841966253ce40c15207bb0ed3da85210`.
[Native qualification run](https://github.com/iamsaiam/LDM/actions/runs/39216049220).
Linux x86_64, Apple Silicon macOS and Intel macOS passed the full native build,
15 CTest groups, 38 JavaScript cases, fresh installation, strict TLS qualification,
benchmark and packaging. CTest times were 41.98 s, 44.36 s and 48.36 s respectively.
CTest includes the JavaScript cases, so those counts overlap.

Linux live extension checks passed in Chrome 155.0.8059.39, Chromium 151.0.7922.34
and Firefox 158.0. They used temporary profiles and generated authenticated local
media: native/network discovery, Cookie/Referer file hashes, overlay controls,
selected 360p MKV with AAC audio, MP3 conversion and worker/runtime recovery.
The popup document was exercised in a browser tab. Toolbar popup geometry and
operating-system notification display were not measured.

The selected media helper uses pinned FFmpeg 9.0.2 source and the included TLS
inheritance patch. Trusted private-CA HLS/DASH and AES-128 HLS inputs must work;
wrong-host media segments and encryption keys must fail. Native HTTPS/FTPS checks
include encrypted data connections and file hashes. Release runtime checks reject
helpers with disabled or unavailable TLS defaults.

Mac fixtures now avoid reverse DNS on loopback startup and use an explicit
certificate configuration. Throttled fixtures use elapsed-time pacing so OS sleep
overshoot does not accumulate into an unintended server rate limit. Archived
benchmark records retain their original fixture revision and hashes.

See [the verification record](docs/VERIFICATION.md) for completed results, the
installed-browser records and the scope of the checks.

## Performance evidence

The [archived loopback benchmarks](benchmarks/README.md) document their fixture
policy and preserve the original measurements. A separate
[external HTTPS check](docs/benchmarks/remote-ffmpeg-2026-10-19/REPORT.md) downloaded
the official 12,040,788-byte FFmpeg source with one and eight requested connections.
Both matched the expected SHA-256. The two single trials recorded 1.70 and
1.81 MiB/s respectively. No controlled IDM/XDM comparison has been completed.

## Distribution scope

The desktop UI runs in the system browser and can be installed as a PWA. Native
packages use compatible system libraries. Mac builds have no Developer ID signing
or notarization. Chromium packages use developer loading; Firefox packages use
temporary installation until Mozilla signing is completed. Interactive clean-host
Finder/Gatekeeper checks and browser store submission remain separate release work.

Detected media must be accessible and supported by the helper. DRM, access-control
bypass, universal website/YouTube extraction and a fastest-downloader claim are
outside the verified scope. Source quality determines the available resolution.
Pure FTP-served HLS media segments remain limited by FFmpeg's HLS reader, while
direct FTP files and FTP playlists referencing HTTP segments are covered.

The optional Flask/yt-dlp backend is experimental and is unused by the native app.
Project source is MIT licensed; external dependencies keep their own licenses.
