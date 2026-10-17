# LDM — Local Download Manager

LDM is an open-source download manager being developed for Linux and macOS. It
combines a C++20/libcurl engine, a local browser dashboard and Chromium/Firefox
extensions. The dashboard is embedded in the engine and can be installed as a PWA;
it runs in the system browser rather than a native widget toolkit.

Project code is released under the [MIT License](LICENSE). External libraries and
FFmpeg retain their own licenses. Linux builds and controlled local fixtures have
been exercised, including installed Chrome, Chromium and Firefox extensions.
Native macOS execution and distribution checks remain part of release qualification.

## Implemented features

- Direct HTTP/HTTPS downloads and FTP/FTPS URLs through the dashboard and local
  API, subject to the protocols enabled in the installed libcurl. Passive FTP has
  real local integration fixtures. HTTPS/implicit FTPS include encrypted passive
  data, one/four connection byte/hash checks, unknown CA rejection and hostname
  mismatch rejection.
- Verified HTTP byte ranges, up to eight range workers, retry handling and safe
  reuse of partial chunks when an ETag or Last-Modified validator permits it.
  Servers that ignore ranges fall back to a sequential transfer.
- Pause, Resume and Cancel in the dashboard, extension popup and player overlay.
  Queued work can be paused too. Pausing preserves the active engine job; Cancel
  stops direct workers and FFmpeg/ffprobe processing.
- Download cards with transferred size, total size, percentage, rate and ETA for
  direct files. Unknown totals stay indeterminate. HLS/DASH shows muxed output
  bytes and processing progress, without claiming measured network rate or ETA.
- HLS/DASH inspection using actual ffprobe streams, followed by a video quality,
  audio track and file-format chooser in the dashboard and extension popup.
  Available resolutions come from the source: 720p, 1080p or higher appears only
  when the inspected playlist exposes it.
- Selected video/audio tracks merged into MP4 or MKV. Audio-only output supports
  M4A, MP3 and Opus. Video codecs are copied to preserve source quality; audio is
  copied when compatible or converted using FFmpeg's available encoders. An
  incompatible MP4 selection produces an error suggesting MKV.
- An optional absolute save-folder path in the desktop dashboard. With no folder,
  browser-client downloads go to the current user's Downloads directory. Existing
  files are preserved by choosing numbered filenames.
- Media discovery from browser response metadata, extensionless media requests,
  Content-Disposition filenames and native video/audio player sources. Detection
  tracks source changes, embedded frames and HLS/DASH playlist hints, and skips
  recognized individual fragments and unsupported responses.
- Local transfer history, queue recovery when a browser view reopens, and
  reconciliation with jobs still running in the engine.

A detected stream is a candidate, not a guarantee of a playable complete file.
DRM and access-control bypass are unsupported. Generic detection does not promise
support for every website, YouTube page or streaming service. There is no verified
claim that LDM is faster than IDM/XDM or is the fastest downloader.
The installed FFmpeg HLS reader cannot process pure FTP-served media segments;
direct FTP file downloads remain supported. Engine fixtures cover an FTP-hosted
playlist referencing HTTP segments, without enabling local-file playlist access.

## Project layout

| Path | Purpose |
| --- | --- |
| `cpp-engine/` | C++20 engine, local service and engine/integration fixtures |
| `desktop-ui/` | Embedded local dashboard and PWA assets |
| `extension/` | Chromium/Firefox media detection, popup and player overlay |
| `scripts/` | Dependency checks and safe release packaging |
| `packaging/` | Linux desktop entry and macOS bundle metadata |
| `benchmarks/` | Reproducible local and optional bounded remote measurements |
| `.github/workflows/build.yml` | Native Linux and macOS CI build/test/package jobs |
| `backend/server.py` | Separate experimental Flask/yt-dlp service; not used or packaged by the C++ app |

## Build on Linux

On Debian/Ubuntu, install the build tools, libcurl development files and media
helpers. Python 3.9+ and Node.js 18+ are needed to run all checks and release tools.

```sh
sudo apt install build-essential cmake libcurl4-openssl-dev python3 nodejs ffmpeg
python3 scripts/check_dependencies.py
cmake -S cpp-engine -B build-release -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build-release --parallel 3
ctest --test-dir build-release --output-on-failure
node --test extension/tests/*.test.cjs desktop-ui/tests/*.test.cjs
```

CTest covers output-path safety, the job registry, HTTP reconnect/fallback,
sequential and parallel cancellation, HTTP and helper-process pause/resume, the
public control/inspection API, actual media selection and passive FTP integrity.
The progress backpressure fixture verifies that a UI which stops reading cannot
indefinitely block the engine's transfer/status updates.
FFmpeg media checks need the relevant executables and codecs; Node runs the
browser/dashboard regression fixtures. Local integration checks need loopback
socket permission in a restricted environment.

Install for the current user and launch:

```sh
cmake --install build-release --prefix "$HOME/.local"
"$HOME/.local/bin/ldm-downloader" --app
```

The Linux desktop entry uses `ldm-downloader` from `PATH`; ensure `~/.local/bin`
is available in the desktop session. Use a fresh installation prefix to review an
install without replacing an existing installation.

## Build on macOS

Install Apple's Command Line Tools, CMake and FFmpeg, then use the same configure,
build and check commands above:

```sh
xcode-select --install
brew install cmake ffmpeg node python
```

CMake creates `build-release/LDM.app`. Install it for the current user:

```sh
cmake --install build-release --prefix "$HOME"
open "$HOME/Applications/LDM.app"
```

The native macOS build, Finder launch and clean-host installation have not been
verified on an Apple host here. CI jobs are defined for Apple silicon and Intel
macOS; their presence is not evidence of a completed run. The bundle is unsigned
and unnotarized; public distribution requires that separate release work.

## Use the app

On Linux, open the dashboard or run only the service for the browser extension:

```sh
./build-release/ldm-downloader --app
./build-release/ldm-downloader --server
```

On macOS, use `./build-release/LDM.app/Contents/MacOS/LDM` with the same arguments,
or open the installed app. The default service address is `127.0.0.1:12345`.

For a direct command-line file transfer:

```sh
./build-release/ldm-downloader "https://example.org/file.zip" "/path/to/file.zip"
```

In the dashboard, paste a file URL and optionally set a filename and absolute
save-folder path. For HLS/DASH, the first submit inspects the playlist; choose the
reported tracks and container, then select **Download selection**. Use the format
selector for playlist endpoints without an `.m3u8` or `.mpd` suffix. In the
extension popup, **Choose** inspects a detected playlist before **Download**.
The player overlay can start a detected transfer and provides live controls.

Each client queue allows up to two active tasks. A paused engine job keeps its
queue slot until resumed or cancelled. Pausing operates on the running job; it
does not provide persistence across engine shutdown. If a remote connection
expires while paused, the transfer can require a retry. Validated direct range
chunks can be reused later when the server's identity checks still match.

The dashboard uses local assets only. Active/recent engine status is in memory
and clears when the engine exits. Persistent browser transfer history contains
metadata and state, not source URLs or captured request headers. Active jobs
resync after reopening a view while the engine remains running. Browser-session
queue data supports extension worker recovery; it does not automatically restart
jobs after the engine exits. Temporary/session behavior is subject to the browser.

FFmpeg and ffprobe must be on `PATH` for playlist inspection and processing.
M4A/MP3/Opus conversion additionally depends on the installed FFmpeg encoders.
Inspection does not create a higher quality than the source provides, and stream
selection is available for inspected playlists rather than arbitrary web pages.

LDM explicitly enables certificate verification for HTTPS media inputs. A custom
PEM trust bundle can be supplied to the engine process with `LDM_CA_BUNDLE`; it
replaces libcurl's default CA bundle and is passed to the top-level HTTPS media
helper. This is process configuration, not a field supplied by browser pages.
It does not disable certificate or hostname checks for native HTTPS/FTPS.

FFmpeg 8.0.1 does not propagate the parent's TLS settings to every
HLS segment: an isolated wrong-host segment was accepted during the audit. That
is an unresolved stable-release blocker. The dependency checker reports the
helper's TLS default, and strict qualification fails until the selected helper
rejects that fixture. See the release guide; passing ordinary tests does not
qualify this build as a stable release.

## Load the extension for development

Keep the local engine running. For Chromium, open `chrome://extensions`, enable
Developer mode, choose **Load unpacked**, and select `extension/`.

For Firefox, use the packaging script to create a Firefox-specific ZIP, extract it
into a separate directory, and choose its `manifest.json` from `about:debugging`
→ **This Firefox** → **Load Temporary Add-on**. This uses the Firefox manifest
without modifying the Chromium source. Permanent release/beta Firefox installation
requires Mozilla signing; see the [release guide](RELEASE.md).

The extension requests site and cookie access to discover media and authenticate
user-selected transfers. If a native player request preceded network observation,
cookies are queried only for the selected URL and its tab's cookie store.
Detected URLs and required Cookie/Referer/Origin/User-Agent headers stay in
browser-session state and are sent to the local service only for a user-selected
inspection or download. Navigation clears the previous page's candidates and
late responses are ignored. Ordinary stream-card quality hints can come from
player/URL metadata; the playlist chooser uses actual ffprobe results.

Node fixtures cover queue/control recovery, detection and selection data flow.
Live Linux checks also passed in Chrome 155, Chromium 151 and Firefox 158 with
temporary profiles and generated authenticated media. They covered real transfer
controls, HLS selection, MP3 conversion and restart recovery. See
[repeatable browser checks](scripts/browser-tests/README.md).
Representative streaming sites, authentication expiry and site-specific players
still need their own verification.

## Packaging and performance evidence

See [RELEASE.md](RELEASE.md) for native installation, dependency checks,
Chromium/Firefox packages, source archive creation and checksums. Preview an
artifact plan without creating archives:

```sh
python3 scripts/package_release.py --kind all --build-dir build-release   --output-dir /tmp/ldm-release-review --dry-run
```

Packaging refuses nonempty output directories and excludes build trees, caches,
partial downloads and session data. Native archives are development install
layouts using system dependencies, not self-contained universal applications.
CI prepares artifacts without publishing releases or using signing credentials.

[Benchmark instructions](benchmarks/README.md) describe byte/hash-verified local
fixtures and an optional explicitly supplied remote HTTP(S) test file. The initial
local evidence includes a fixture-listen-queue outlier; the revised fixture records
its backlog and requires new output directories. Preserve the old results.
Synthetic capped throughput demonstrates behavior under that fixture's rate
policy. It does not measure Internet speed or establish a comparison with IDM/XDM.
See [the current verification record](PROGRESS.md) for the revised measurements,
the native and JavaScript checks, and browser dashboard
checks of actual selected HLS output, transfer controls and history.

Before a stable release, verify native macOS execution and installation, installed
Chromium/Firefox flows, representative accessible streaming sources, and the
platform's signing/distribution requirements. Real competitor speed measurements
need a controlled comparison; none has been completed.
