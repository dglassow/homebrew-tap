# Glass Homebrew tap

Install the existing, published **macOS Apple Silicon** Glass release:

```sh
brew tap dglassow/tap
brew trust --cask dglassow/tap/glass
brew install --cask dglassow/tap/glass
```

Homebrew 7 requires explicit trust for third-party packaging. Review this tap before trusting it; the command above trusts only the Glass cask, not every package in the tap.

This tap contains packaging metadata only. Its version-pinned cask fetches `Glass.dmg` from the public [Glass releases](https://github.com/dglassow/Glass/releases); it does not build Glass or publish a new release. Glass also has its own signed in-app updater. Homebrew's `auto_updates` handling and the cask's upgrade guard retain a newer self-updated bundle rather than replace it with an older tap release. `brew reinstall` deliberately replaces the app with the tap baseline; use Glass's signed updater instead when the installed app is newer.

## Updating the tap

1. Publish and verify a **stable, non-draft** `dglassow/Glass` GitHub release with a `vX.Y.Z` tag, exactly named `Glass.dmg` and `SHA256SUMS` assets, and their published SHA-256 asset digests. Do not run `ship` to update the tap.
2. In the Glass source checkout, run `./release.sh homebrew X.Y.Z`. This downloads the published DMG, hashes it, and checks its size/digest against both GitHub asset metadata and the published `SHA256SUMS` line. An absent or inconsistent artifact, prerelease, draft, invalid tag, or downgrade leaves the cask unchanged. Same-version asset replacement is refused. The command only stages `distribution/homebrew/Casks/glass.rb`; it does not push, release, install, or restart anything.
3. Review the diff: only `version` and `sha256` should change. Confirm the version-pinned download URL and platform remain correct.
4. Copy the reviewed `distribution/homebrew/` contents to the public `dglassow/homebrew-tap` repository root, preserving `Casks/glass.rb`, this README, the updater, both test files, and `.github/workflows/homebrew.yml`. Review and commit/push only this metadata, then require the tap's CI to pass before advertising the update. CI registers its checkout as a local tap, runs `node --test update-cask.test.mjs lifecycle.test.mjs`, `brew style Casks/glass.rb`, and `brew audit --cask --strict dglassow/tap/glass`, and exercises installation and cleanup against the published app. The Xcode 27 runner supplies the current Homebrew developer-tools requirement. The tap repository must not receive Glass application source, configs, secrets, private signing material or release artifacts.

For local verification, register the reviewed checkout under `$(brew --repository)/Library/Taps/dglassow/homebrew-tap` before running the same commands. Homebrew will not load a cask from an arbitrary directory. The real launchd teardown smoke skips a user domain already running Glass, so it cannot stop an existing fleet backend.

Upgrading or reinstalling through Homebrew does not terminate Glass, its backend, computer service, or running terminal sessions. Plain `brew uninstall --cask glass` removes the app and the cleanup command but deliberately leaves the persistent backend and all data intact. To stop owned services and remove the app, run **`glass-uninstall` before ordinary uninstall**. This explicitly requested cleanup verifies the owned launch agents and CLI symlinks, stops those agents, and invokes Homebrew to remove the app. It preserves `~/.glass`, including runtimes, settings, credentials, transcripts and backups, and leaves unrelated commands untouched. If only the app was removed, reinstall the cask to restore the cleanup command; installation itself does not restart the backend.

Service teardown ends active terminal sessions and agent runs on this Mac. Back up and finish active work before running `glass-uninstall`. Deleting local data is a separate, destructive manual action, never part of an upgrade or routine uninstall. The cask does not reset or migrate existing installation state.
