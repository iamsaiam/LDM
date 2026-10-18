# Qualified streaming media helper

The official FFmpeg 9.0.2 source is pinned to SHA-256
`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`.
The downloaded release was verified with the official release signing key
`FCF986EA15E6E293A5644F10B4322F04D67658D8` in a temporary keyring.
Source and release verification instructions are on [FFmpeg's download page](https://ffmpeg.org/download.html).

FFmpeg 9 enables TLS verification by default. Its HTTP option discovery still
needs the included patch to retain a selected CA file for nested HLS/DASH requests.
The patch exposes the lower HTTP transport as an AVOptions child and copies only
`ca_file` and `tls_verify` alongside the existing HTTP settings. It does not copy
the parent's automatically chosen hostname. Child URLs must authenticate their
own hostname. HLS encryption keys use the same inherited settings.

## Build prerequisites

```sh
# Debian / Ubuntu
sudo apt install build-essential pkg-config nasm libgnutls28-dev libx264-dev \
  libmp3lame-dev libopus-dev libxml2-dev

# macOS with Command Line Tools
brew install pkgconf nasm gnutls x264 lame opus libxml2
export PKG_CONFIG_PATH="$(brew --prefix libxml2)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
```

Run from the LDM source directory:

```sh
python3 scripts/build_media_helper.py --download --output-dir /tmp/ldm-helper-build --jobs 3
export PATH="/tmp/ldm-helper-build/runtime/bin:$PATH"
cmake -S cpp-engine -B build-qualified -DCMAKE_BUILD_TYPE=Release \
  -DLDM_REQUIRE_VERIFIED_MEDIA_TLS=ON
cmake --build build-qualified --parallel 3
ctest --test-dir build-qualified --output-on-failure
```

The output folder must be new or empty. `--source /path/to/ffmpeg-9.0.2.tar.xz`
uses a previously downloaded official tarball and still checks the pinned hash.
The builder does not install files into system directories. Its native executables
use the development host's shared GnuTLS and codec dependencies; they are not
universal portable binaries. Build separately on each target system.

## Qualification and distribution

Compilation does not mark a helper qualified. The engine's strict TLS fixture
checks trusted and untrusted authorities, wrong hostnames, HTTPS/FTPS file hashes,
HLS/DASH media segments and an AES-128 HLS key. Positive private-CA downloads are
required alongside rejection cases. The runtime guard rejects helpers whose TLS
verification default is disabled or unavailable.

FFmpeg built with x264 is GPL version 2 or later. The runtime directory retains
its GPL license, full original FFmpeg source, patch, build script and build metadata.
Third-party dependencies retain their own licenses. LDM's subprocess integration
and its MIT license are separate. Preserve these sources and license files when
redistributing helper binaries. The GitHub workflow uploads the helper evidence,
binaries and accompanying sources with its development artifacts.

Use the qualified directory on `PATH` when launching LDM. Finder's default
Homebrew fallback must be checked independently if a different helper is installed
there. Public app packaging, dependency installation and signing require the
native platform's verification; a Linux helper build does not prove Mac execution.
