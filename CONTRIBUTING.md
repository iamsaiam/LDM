# Contributing to LDM

LDM targets Linux and macOS. Changes should preserve transfer integrity, clear
status reporting and consistent controls across the dashboard and extension.

## Development workflow

1. Fork the repository and create a branch for one focused change.
2. Follow the [README build instructions](README.md#get-started). Build media
   helpers when working on streaming or running the full native checks.
3. Make the change and update relevant documentation.
4. Run the checks affected by the change and record their results in the pull
   request. Full release verification runs in GitHub Actions.

```sh
cmake --build build-release --parallel 3
ctest --test-dir build-release --output-on-failure
node --test extension/tests/*.test.cjs desktop-ui/tests/*.test.cjs
```

[Installed-browser fixtures](scripts/browser-tests/README.md) use temporary
profiles and generated localhost media. Keep browser/session data, downloaded
files, build trees and credentials outside commits. Native macOS checks require a
Mac; `scripts/verify_macos.py` records their results.

## Pull requests

Describe the observed problem, the change and how it was checked. Attach a
screenshot for visible UI changes and reproduction steps for transfer failures.
State the OS, architecture, browser and helper versions when relevant. Use small,
reviewable commits, such as `fix(engine): handle a missing range validator`.

Downloads must preserve output integrity and existing files. Display measured
progress accurately. Keep credentials outside persistent history and qualify
helper TLS behavior with both successful and rejected requests.

Use [issues](https://github.com/iamsaiam/LDM/issues) for bugs and feature proposals.
Follow [SECURITY.md](SECURITY.md) for sensitive reports. Contributions use the
project's MIT license; third-party code and assets need compatible attribution.
