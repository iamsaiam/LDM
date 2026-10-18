# LDM implementation status

LDM means **Local Download Manager**. Linux and macOS are the main targets.
This file records implemented behavior separately from external release evidence.
The final project ZIP is created only when the release work is ready.

## Implemented transfer controls and desktop experience

- C++ jobs accept Pause, Resume and Cancel. Curl workers wait while paused;
  FFmpeg/ffprobe helpers pause and continue with the same job. Cancellation can
  stop stalled helpers, including escalation when a process ignores termination.
- The dashboard, extension popup and player overlay expose transfer controls.
  Queued jobs can be paused before starting, active paused jobs keep their queue
  slot, and resumed/cancelled states reconcile through the local job registry.
- Direct transfers show transferred/total bytes, percentage, rate and ETA. Unknown
  totals remain indeterminate. Playlist processing shows muxed output bytes and
  processing progress; network speed/ETA are not measured for FFmpeg transfers.
- An undrained progress connection has a bounded send timeout instead of blocking
  the transfer callback indefinitely. Downloads continue and their state remains
  available through the status API when a UI stops reading progress.
- The dashboard provides an optional absolute save-folder path, local history,
  keyboard-accessible controls and stable card/button nodes during progress.
  A missing folder uses Downloads for browser-client tasks. Output collisions
  choose numbered filenames rather than replacing an existing file.
- The dashboard is an embedded local browser UI/PWA with local assets. It is not
  a native widget-based window. The engine remains the native C++ component.

Pause/resume keeps the existing engine process alive. It does not persist an
active job across engine shutdown. HTTP range chunks can be reused later only
when server validators and engine resume checks still match. Paused remote
connections can expire and require retrying.

## Implemented media inspection and selection

- `/api/inspect` invokes ffprobe with bounded active-time processing and returns
  actual video/audio stream indices, dimensions, codecs, bitrate, language,
  default status and program membership when available.
- The dashboard and extension popup show a playlist chooser for actual available
  qualities and audio tracks. The user can select automatic best/matching tracks,
  explicit tracks, video-plus-audio output or audio-only output.
- MP4 and MKV video output maps only the selected streams. Video packets are
  copied; incompatible MP4 codecs produce an explicit MKV suggestion.
- Audio-only M4A, MP3 and Opus copy compatible source audio or transcode using the
  installed FFmpeg encoders. HLS program matching prefers audio belonging to the
  selected video rendition. Arbitrary selected tracks must exist in the source.
- Available 720p/1080p/4K or higher choices depend on the actual playlist; the app
  does not synthesize missing resolutions. This flow is for HLS/DASH inputs, not
  an unrestricted extractor for every video web page.

## Implemented protocols and discovery

- HTTP/HTTPS and FTP/FTPS URLs are accepted by the dashboard and local download
  API, subject to libcurl capabilities. HTTP byte ranges are verified before
  parallel transfer; non-range servers fall back to sequential download.
- Passive FTP has a dedicated local fixture covering metadata, restart offsets,
  data connections, exact bytes/SHA-256 and completed job status. HTTPS and implicit
  FTPS now have a TLS fixture with encrypted FTP data, one/four connection byte/hash
  checks, unknown CA rejection and mismatched hostname rejection.
- Native curl requests explicitly verify peer certificates and hostnames and avoid
  process signals in threaded workers/metadata probes. `LDM_CA_BUNDLE` configures
  a process-specific PEM trust bundle. HTTPS ffprobe/FFmpeg inputs explicitly enable
  verification and receive that bundle. Plain HTTP/FTP media paths retain support.
- The helper audit found that installed FFmpeg 8.0.1 accepts a wrong-host nested
  HLS segment even when the parent HTTPS input enables verification. Release builds
  now reject helpers with disabled TLS defaults at runtime. The pinned FFmpeg
  9.0.2 helper exposes HTTP transport options and preserves CA/verification settings
  for nested HLS/DASH media and AES-128 keys. Its strict local trust fixtures passed.
  Qualification uses the selected helper build rather than a version claim alone.
- The engine media fixture also covers an FTP-hosted playlist pointing to HTTP
  segments, with remote-playlist local-file access denied. Pure FTP-served HLS
  segments are unsupported by the installed FFmpeg HLS reader; this upstream
  limitation does not remove direct FTP file support.
- Extension discovery combines network response evidence with native video/audio
  sources, including extensionless endpoints, Content-Disposition filenames,
  source alternatives, relative URLs, source changes and embedded frames.
- Recognized HLS/DASH endpoints and response filenames carry a manifest hint to
  the engine. Recognized individual fragments, explicit nonmedia/error responses,
  non-GET requests and unsupported URL schemes are excluded.
- Captured identity headers and media URLs stay in temporary browser-session data;
  persistent transfer history contains metadata/state. Only a user-selected
  inspection or download sends the required data to the local engine.
- Detection does not bypass DRM/access controls and does not promise complete
  downloads from every website or YouTube. Installed-browser/site coverage still
  needs live checks.

## Implemented release preparation

- `scripts/check_dependencies.py` reports build/media tools without installing
  anything. `scripts/package_release.py` supports a dry run, native install
  archives, Chromium/Firefox-specific ZIPs, source archives and SHA-256 manifests.
- Packaging refuses existing output, selects source/runtime inputs, and excludes
  build trees, dependencies, caches, partial files, session data and generated
  benchmark results. Temporary native staging does not install into the user's
  normal application directories.
- Linux desktop launch/icon metadata and macOS bundle metadata are provided.
  Native packages rely on system libcurl/FFmpeg and are not universal standalone
  distributions. The macOS app has no developer signing or notarization.
- `.github/workflows/build.yml` defines native Ubuntu, Apple silicon macOS and
  Intel macOS build/check/package jobs with read-only repository permissions.
  It does not publish a release or submit/sign an extension.
- `RELEASE.md` explains builds, installation, package review, extension loading,
  distribution constraints and the remaining release gate.

## Linux verification and performance evidence

- The current Linux Release build passed all **15 CTest groups in 40.58 seconds**,
  including the integrated JavaScript group with **38 passing tests**. Counts are
  not added together. Coverage includes output reservation, registry
  controls/recovery, HTTP reconnect/fallback, sequential/parallel cancellation,
  HTTP/helper pause-resume, public API controls/inspection, media stream selection
  with generated HLS/DASH fixtures, passive FTP output integrity, native HTTPS/FTPS
  TLS trust/name checks, release helper rejection policy, and an undrained progress client. The dependency checker
  found no missing tools with the bundled Node runtime and qualified media helpers;
  CMake used Node v24.19 because this sandbox cannot launch the system Snap node.
- Browser dashboard QA completed an actual selected 360p H.264/AAC HLS transfer
  into MKV; ffprobe verified the output resolution/codecs. Pause, Resume, Cancel
  and history were observed in the browser. Workspace screenshots:
  [quality selection](docs/images/dashboard.png). These dashboard checks
  and Node fixtures do not verify an installed Chromium/Firefox extension.
- Installed Chrome 155.0.8059.39, Chromium 151.0.7922.34 and Firefox 158.0 passed
  generated local media checks in fresh temporary profiles. These exercised real
  player discovery, Cookie/Referer authentication with exact file hashes, overlay
  Pause/Resume/Cancel, selected 360p MKV plus audio, popup Audio only/MP3 conversion,
  and history recovery after a worker/extension restart. Popup documents ran as
  actual extension pages in browser tabs; toolbar popup window geometry was not
  measured. See `scripts/browser-tests/README.md` for repeatable checks.
- Live tests led to current-header refresh at queue/inspection time, URL-scoped
  cookie lookup for native sources missed by network observation, correct extension
  tab targeting, and selection badges that follow the chosen quality/format.
  Credentials remain outside persistent transfer history. Both manifests declare
  the cookie permission used for selected transfers.
- A fresh Linux install executed the native engine, served its embedded dashboard,
  downloaded exact bytes into `LDM_DOWNLOAD_DIR` and created verified MKV plus audio.
  `scripts/check_native_install.py` repeats this check. `scripts/verify_macos.py`
  requires a native Mac. CI includes clean installations and strict TLS checks on
  Linux and both Mac architectures; source/workflow preparation does not imply a
  completed Mac run.
- Temporary Chromium/Firefox archives were inspected for the correct manifest,
  runtime assets and ZIP integrity; overwrite refusal was checked. Temporary Linux
  native archives preserved the executable hash/permissions, launcher, icon and
  documentation. Source plans excluded caches/build outputs/results.
- The original 32 MiB local fixture evidence is preserved in
  `benchmarks/results/per-response-8mib` and `benchmarks/results/uncapped`.
  Capped medians were about 7.77 MiB/s (one connection) and 19.58 MiB/s (eight).
  All hashes matched. The uncapped eight-connection run contained a 1.171-second
  outlier alongside approximately 0.190/0.181-second trials.
- The initial fixture used a small default listen backlog. Revision 2 explicitly
  sets backlog 64 and records the fixture/script identity. The backlog is a
  plausible cause of startup delays; no packet trace proves retransmission.
  Original results remain unchanged. The revision-2 results are in fresh
  directories and all 12 trial outputs matched the expected bytes and SHA-256:

  | Local 32 MiB fixture | 1 connection median | 8 connections median | Evidence |
  | --- | ---: | ---: | --- |
  | Per-response 8 MiB/s cap | 7.82 MiB/s (4.091 s) | 53.74 MiB/s (0.595 s) | [report](docs/benchmarks/per-response-8mib-backlog64/REPORT.md), [JSON](docs/benchmarks/per-response-8mib-backlog64/results.json) |
  | Uncapped loopback | 310.05 MiB/s (0.103 s) | 369.69 MiB/s (0.087 s) | [report](docs/benchmarks/uncapped-backlog64/REPORT.md), [JSON](docs/benchmarks/uncapped-backlog64/results.json) |

  Both revised runs used executable SHA-256
  `00db57609bd6409f5b47fcc4577b452a415320ad6868a3e7a2bc32975609f2ef`.
  The payload was 33,554,432 bytes with SHA-256
  `c5febe7f44faea048a51663faa8228bb80c76b606644caf5accc5c04b858fdf9`.
  The earlier runs used another executable as well as a different fixture;
  these values cannot isolate an engine improvement. The capped case deliberately
  favors independent range connections, and uncapped loopback measures local
  CPU/cache/disk/server behavior. Neither represents Internet or IDM/XDM speed.
- `benchmarks/remote_http.py` provides an optional explicitly supplied HTTP(S)
  measurement with a HEAD size cap, byte/hash consistency checks and temporary
  output. `--preflight-only` starts no engine. Endpoint refusal, unknown sizes or
  rate limits stop the attempt. No successful real-Internet competitor benchmark
  is recorded here; local fixture throughput is not Internet speed.

## Remaining release evidence

0. Ship or install the qualified media helper with its sources and licenses.
   Patched FFmpeg 9.0.2 passed the local nested trust checks; legacy 8.0.1 is not
   qualified. Repeat qualification for each native release build.
1. Run the native macOS CI jobs or use actual Intel/Apple silicon hosts. Verify
   Finder launch, helper discovery, pause/resume and a clean-prefix installation.
   A Linux build arranged as an app bundle cannot verify native macOS behavior.
2. Local installed Chromium/Chrome/Firefox flows passed. Verify authentication
   expiry, embedded players and representative accessible streaming sites before
   making broader extraction claims.
3. A real IDM/XDM comparison still needs the same controlled source, connection
   cap, hashes, network and repeated runs for each program. No fastest/best-
   downloader claim is supported.
4. Complete public distribution steps when ready: macOS developer signing and
   notarization, Firefox signing, browser store submission if desired, and checks
   on clean target systems with documented system dependencies.

These external requirements remain distinct from the implemented Linux features.
The project can be reviewed and built locally now; it is not yet an externally
verified stable release on both target platforms.
