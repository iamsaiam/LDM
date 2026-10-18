# Live browser extension checks

These checks install the actual extension into fresh temporary browser profiles
and exercise generated local media against the native engine. No personal browser
profile is used, and no media is downloaded from a streaming service.

Requirements: a built engine, FFmpeg/ffprobe with H.264/AAC support, Python 3.9+,
Node.js 18+, Playwright 1.62.1, and the browser executables. Firefox checks use
Mozilla geckodriver. Install test dependencies into a separate temporary directory;
the project does not download or ship browsers. Keep the fixture running while
checking one browser at a time, because reports identify new native engine jobs.

## Start a local fixture

Port 12345 must be free. The fixture refuses to replace an existing engine.
All downloads go to its generated temporary folder through `LDM_DOWNLOAD_DIR`.

```sh
python3 scripts/browser-tests/fixture.py --engine /absolute/path/to/ldm-downloader \
  --state-file /tmp/ldm-browser-state.json --stop-file /tmp/ldm-browser-stop
```

Remove a leftover stop marker before starting. After testing, create the stop
marker or interrupt the fixture in its terminal to stop the engine and remove
its generated media. `--keep-files` preserves its engine log, synthetic request
headers and media for diagnosis; these files must not be distributed.

## Chromium and installed Chrome

The Node runtime must be able to resolve `playwright`. A separately installed
Playwright Chromium can be selected with `PLAYWRIGHT_BROWSERS_PATH`.

```sh
node scripts/browser-tests/chromium.cjs --fixture /tmp/ldm-browser-state.json \
  --artifacts /tmp/ldm-browser-evidence

node scripts/browser-tests/chromium.cjs --fixture /tmp/ldm-browser-state.json \
  --artifacts /tmp/ldm-browser-evidence --chrome /absolute/path/to/google-chrome
```

The installed Chrome path uses the browser's debugging pipe and
`Extensions.loadUnpacked` in a temporary profile. The default run uses Chromium
with normal unpacked extension launch arguments. Browser sandboxing stays enabled
by default. If a test environment cannot support that sandbox, the runner requires
explicit `--allow-no-sandbox`. Use that exception only with generated local media
and a fresh profile. Production browser settings are unaffected.

## Firefox

```sh
python3 scripts/browser-tests/firefox.py --fixture /tmp/ldm-browser-state.json \
  --artifacts /tmp/ldm-browser-evidence --firefox /absolute/path/to/firefox \
  --geckodriver /absolute/path/to/geckodriver --allow-browser-ui
```

Firefox requires the explicit browser UI flag for WebDriver access to extension
pages. It enables geckodriver's loopback-only `--allow-system-access` for this
session. The driver can then control privileged browser UI, so use only the
isolated test profile. Firefox's content sandbox remains enabled. The add-on is
temporary; signature enforcement is not disabled.

## Evidence and scope

Each runner writes JSON results and screenshots. Checks include native player
and network discovery, a Cookie/Referer protected file with SHA-256 validation,
Pause/Resume/Cancel and partial output cleanup, actual HLS track inspection and
360p MKV plus audio, popup MP3 conversion, and history recovery after a worker or
extension restart. Popup HTML runs as an extension document in a browser tab;
these checks do not measure the browser toolbar popup's outer window geometry.
The direct file requires a real HttpOnly browser cookie. If its request preceded
network observation, LDM can query cookies for the selected URL and tab store.
Credentials are not placed in persistent download history.

Successful local fixtures do not prove every streaming site's extraction, DRM,
store signing, native macOS execution, or Internet speed relative to other apps.
