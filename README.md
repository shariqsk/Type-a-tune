# Type-a-tune

Type-a-tune turns typing into a piano performance.

Drop in a song, let the app analyze its rhythm, and then advance through the track one musical step at a time as you type. It is built as a Tauri desktop app with a minimal interface, low-latency audio playback, a typing game layer, and an optional background-typing mode for desktop use.

## What It Does

- Upload an MP3 or use the bundled demo track.
- Detect playable beat markers from the song.
- Advance the song with each key press.
- Switch between `Song slices` and `Piano interpretation`.
- Rewind with `Backspace`.
- Play as a freeform typing instrument or as a scrolling typing game.

## Downloads

- [GitHub Releases](https://github.com/shariqsk/Type-a-tune/releases)
- macOS (Apple Silicon): download the latest `.dmg` from the releases page when available.
- Windows: planned release download on the same releases page.

Current packaged artifacts created from this repo:

- macOS app bundle: [`src-tauri/target/release/bundle/macos/Type-a-tune.app`](./src-tauri/target/release/bundle/macos/Type-a-tune.app)
- macOS installer: [`src-tauri/target/release/bundle/macos/Type-a-tune_0.1.0_arm64.dmg`](./src-tauri/target/release/bundle/macos/Type-a-tune_0.1.0_arm64.dmg)

## Install

### macOS

1. Download the latest `.dmg`.
2. Open it and move `Type-a-tune` into `Applications`.
3. Launch the app.
4. If you enable background typing, macOS may ask for keyboard monitoring permission.

### Windows

1. Download the latest Windows installer from the releases page.
2. Run the installer.
3. Launch the app and allow any required permissions for background typing when prompted.

Windows packaging is not published from this machine yet, so the README points to the releases page rather than a checked-in installer.

## Run From Source

### Requirements

- Node.js
- Rust
- Tauri prerequisites for your OS

### Development

```bash
npm install
npm run tauri dev
```

### Production Build

```bash
npm run tauri -- build --bundles app
```

## Notes

- `Song slices`, `Slow`, and `Keep song pace` are the current defaults.
- Background typing on macOS works best from the packaged app, not just from `tauri dev`.
- Lyrics mode is currently marked `WIP`.

## Stack

- Tauri
- React
- TypeScript
- Web Audio API
- Rust
