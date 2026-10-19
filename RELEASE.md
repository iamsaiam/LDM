# Build, package and release LDM

The project has a local C++ engine, an embedded browser dashboard, and separate
Chromium/Firefox extension packages. The native engine is versioned by
`cpp-engine/CMakeLists.txt`; browser package versions come from their manifests.
They currently use separate version numbers and artifact names record both.

## Prerequisites

Direct file downloads require the native engine and its system libcurl runtime.
Media inspection, HLS/DASH and audio/video merging also require `ffmpeg` and
`ffprobe` on `PATH`. They are separate third-party tools and are not bundled.
Release builds require both helpers to enable TLS verification by default.
The pinned helper build described below also preserves trust settings for nested
HLS/DASH media and encryption keys.
See the [helper guide](packaging/media-helper/README.md) for codec/TLS development
packages; a distribution FFmpeg package may fail release qualification.
To build and check all components, use CMake 3.16+, a C++20 compiler, libcurl
development files, Python 3.9+, Node.js 18+, FFmpeg and ffprobe.

```sh
# Debian / Ubuntu
sudo apt install build-essential cmake libcurl4-openssl-dev python3 nodejs ffmpeg

# macOS, after Apple's Command Line Tools are installed
brew install cmake curl ffmpeg node python
export CURL_ROOT="$(brew --prefix curl)"

# Build the pinned helper using the development dependencies in its guide:
# packaging/media-helper/README.md
python3 scripts/build_media_helper.py --download --output-dir media-helper-build --jobs 3
export PATH="$PWD/media-helper-build/runtime/bin:$PATH"
python3 scripts/check_dependencies.py
```

Use `--json` for a structured dependency report. `--runtime-only` checks the
media executables without requiring development tools. A missing FFmpeg does not
prevent a direct file download. CMake verifies the compiler and libcurl headers
and library. The checker does not install software or contact a package server.

## Build and run checks

```sh
cmake -S cpp-engine -B build-release -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build-release --parallel 3
ctest --test-dir build-release --output-on-failure
node --test extension/tests/*.test.cjs desktop-ui/tests/*.test.cjs
```

Native Linux binary: `build-release/ldm-downloader`.
Native macOS binary: `build-release/LDM.app/Contents/MacOS/LDM`.
Run the binary with `--app` to open the dashboard, or with `--server` to keep
only the local service running for the extension. The default port is 12345.

`.github/workflows/build.yml` defines native Ubuntu, Apple silicon macOS and Intel
macOS jobs. Each job builds the pinned media helpers, builds the engine with the
runtime trust guard enabled, runs CTest and all JavaScript regression files, checks
download hashes with a small local benchmark, stages a native install and uploads
development artifacts with checksums. It has read-only repository permissions and
does not publish a GitHub release, submit a browser extension, sign an app or use
credentials. Completed native results and the exact source commit are recorded
in [the verification record](docs/VERIFICATION.md). Repeat qualification for each
release and preserve its native install report, helper metadata and checksums.

For a Mac outside CI, run `python3 scripts/verify_macos.py --output-dir /absolute/path/to/new-evidence`
with qualified helpers on `PATH`. It builds and runs native checks, validates
strict TLS behavior and executes a fresh installation. The script refuses to
claim a native Mac result on Linux. Finder launch and developer signing are
reported separately from these automated checks.

## Prepare packages

Preview every artifact before writing it:

```sh
python3 scripts/package_release.py --kind all --build-dir build-release \
  --output-dir /tmp/ldm-release-review --dry-run
```

Create all packages when ready, or choose `source`, `extensions` or `native`:

```sh
python3 scripts/package_release.py --kind all --build-dir build-release \
  --output-dir /tmp/ldm-release-review
```

The output directory must be new or empty. Files are opened exclusively so
existing artifacts are never silently replaced. Source and extension ZIPs use
sorted inputs, stable permissions and a fixed timestamp for reproducible output.
Set `SOURCE_DATE_EPOCH` to a release timestamp in Unix seconds when needed.
`SHA256SUMS` records every artifact's digest. Source archives use an explicit list
of source directories and file types; build trees, dependencies, caches, browser
data, benchmark output, partial downloads and environment files are excluded.
Extension archives include only browser runtime files, the selected manifest as
`manifest.json`, and the project license. Regression fixtures are excluded.

Native `.tar.gz` packages are development install layouts for the current host,
created through `cmake --install` into a temporary directory. They preserve
executable permissions and include `BUILD-INFO.json` plus this guide. They are
not universal Linux binaries or self-contained macOS bundles: system libcurl and
its dependencies must be compatible, and FFmpeg/ffprobe must be installed for
media tasks. A package built on a newer Linux distribution may not run on one
with an older glibc. Build from source on the target system if incompatible.
No binaries are downloaded by the packaging script.

For a private certificate authority, start the engine with
`LDM_CA_BUNDLE=/absolute/path/to/authorities.pem`. This replaces the native curl
CA bundle and configures top-level HTTPS helper input. Certificates and hostnames
are still checked by native HTTPS/FTPS requests. Keep any needed public roots in
the supplied bundle too. This does not guarantee that an external media demuxer
inherits the setting for every nested playlist resource.

## Install for development

On Linux, install a build for the current user:

```sh
cmake --install build-release --prefix "$HOME/.local"
"$HOME/.local/bin/ldm-downloader" --app
```

This installs a desktop entry, local icon and executable; `~/.local/bin` must be
on the desktop session's `PATH` for the menu launcher. The PWA dashboard runs
locally in the browser and can be installed as a web app by supporting browsers.

On macOS:

```sh
cmake --install build-release --prefix "$HOME"
open "$HOME/Applications/LDM.app"
```

These install commands update the selected prefix; choose a fresh prefix to
review an install without replacing an existing installation. The app is unsigned
and unnotarized. Public macOS distribution still needs an Apple Developer signing
identity, notarization and a clean-host installation check. No claim of successful
Mac developer signing is made by the automated native CI checks. Interactive
Finder/Gatekeeper behavior remains separate from the installed process checks.

## Load extension packages

Extract the Chromium ZIP into its own directory. In `chrome://extensions`, enable
Developer mode and choose **Load unpacked** for that directory. Keep the local
engine running. Normal public installation should use a browser store listing;
Chromium's platform-specific external installation rules are documented by
[Chrome](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).

Extract the Firefox ZIP into a separate directory and choose its `manifest.json`
under `about:debugging` → **This Firefox** → **Load Temporary Add-on**. This
temporary installation ends when Firefox restarts. Permanent release/beta Firefox
installation requires Mozilla signing via AMO, including for self-distribution;
see [Mozilla's signing guide](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
Packaging a ZIP does not sign it or make it a permanently installable XPI.

The extension requires broad site access to discover media and loopback access to
send a selected download to LDM. Test ordinary media, embedded frames, navigation,
popup reopen, queue recovery, pause/resume, cancellation and media selection in an
installed Chromium and Firefox extension before a public release. A Node fixture
or dashboard browser screenshot alone does not prove live extension behavior.

## Performance evidence and release gate

Qualify the media helper's nested TLS behavior before a stable release:

`scripts/build_media_helper.py` builds official FFmpeg 9.0.2 source with a pinned
SHA-256 and the reviewed TLS inheritance patch. The upstream source checksum was
verified against the FFmpeg release signing key. The patch exposes the HTTP
protocol's lower transport options and forwards `ca_file` and `tls_verify` to
HLS/DASH children. Each resource retains its own hostname verification.
The build needs GnuTLS, x264, LAME, Opus and libxml2 development files, pkg-config,
make, a C compiler and the platform assembler. See
[media helper instructions](packaging/media-helper/README.md).

```sh
python3 scripts/build_media_helper.py --download --output-dir /tmp/ldm-media-helper-build
export PATH="/tmp/ldm-media-helper-build/runtime/bin:$PATH"
```

The runtime directory includes source, patch, license and build information.
Its FFmpeg configuration is GPL version 2 or later; it is a separate dependency
from LDM's MIT code. A successful compilation is followed by qualification:

```sh
cmake -S cpp-engine -B build-qualified -DCMAKE_BUILD_TYPE=Release \
  -DLDM_REQUIRE_VERIFIED_MEDIA_TLS=ON
cmake --build build-qualified --parallel 3
ctest --test-dir build-qualified --output-on-failure -R tls-download-trust
```

This strict check requires OpenSSL CLI and FFmpeg/ffprobe. It generates a
temporary private CA and services, checks native HTTPS/FTPS trust/name rejection,
and requires wrong-host HLS/DASH segments and an AES-128 HLS key to be rejected.
Trusted private-CA media must also download successfully. No system trust store
is changed. FFmpeg 8.0.1 fails the nested check; the patched 9.0.2 helper passed
these real local fixtures. Native CI repeats qualification on each release
architecture; completed evidence is linked from the verification record.

`LDM_REQUIRE_VERIFIED_MEDIA_TLS` defaults to `ON`. It checks both helpers' TLS
defaults at runtime before media inspection and adds strict checks to CTest.
Direct file downloads continue to use native libcurl verification. An explicitly
disabled guard is a development configuration and cannot qualify for release.

Use [the benchmark instructions](benchmarks/README.md) to record byte-verified,
repeatable local measurements. Report the build and test conditions alongside the
numbers. A local per-response throttle can show the benefit of range connections;
it cannot establish real Internet speed or superiority over IDM/XDM.

Before calling a release stable, keep evidence of native Linux and macOS checks,
clean-prefix installation, installed Chromium/Firefox flows, real authorized media
fixtures, and benchmark output integrity. Browser store submission, Apple signing,
and real Internet competitor measurements need their respective external hosts,
accounts or controlled test setup. DRM and access-control bypass are unsupported.
The project MIT license is included; external libcurl/FFmpeg licenses remain theirs.
