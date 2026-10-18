# Changelog

## Unreleased

### Added

- Native C++20/libcurl engine with verified parallel HTTP ranges, fallback,
  retries, output reservations and validated partial-download reuse.
- Local dashboard/PWA, Chromium and Firefox extensions, media discovery and
  player overlay integration.
- Pause, Resume and Cancel, direct-file rate/ETA and recoverable browser history.
- HLS/DASH stream selection, MP4/MKV output and M4A/MP3/Opus audio extraction.
- Pinned FFmpeg helper builder, inherited media TLS trust and runtime helper checks.
- Native Linux and Intel/Apple Silicon macOS CI, installation checks, packaging,
  checksums and reproducible benchmark fixtures.

### Fixed

- Refresh authenticated request headers when inspecting or queuing a transfer.
- Query URL-scoped cookies for a selected native source missed by network discovery.
- Keep displayed quality/format labels aligned with selected media tracks.
- Join IPC client threads using APIs supported by Apple's C++ standard library.
- Locate the Homebrew LAME headers and library on Apple Silicon.

See [verification](docs/VERIFICATION.md) for the evidence behind release claims.
