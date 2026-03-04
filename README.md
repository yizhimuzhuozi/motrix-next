<div align="center">
  <h1>Motrix Next</h1>
  <p>A full-featured download manager — rebuilt from the ground up.</p>

  ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)
  ![License](https://img.shields.io/badge/license-MIT-blue.svg)
</div>

---

## Background

Motrix Next is built upon the ideas of [Motrix](https://github.com/agalwood/Motrix) by [agalwood](https://github.com/agalwood). We are grateful to the original creators and contributors — their aria2 integration, i18n translations, and download logic served as invaluable reference throughout development.

The legacy Electron + Vue 2 stack had become difficult to maintain. Rather than patching further, Motrix Next rebuilds the application with a modern architecture:

- **Runtime** — Electron → **Tauri 2** (Rust-based, significantly smaller and lighter)
- **Frontend** — Vue 2 + Vuex + Element UI → **Vue 3 Composition API + Pinia + Naive UI**
- **Language** — JavaScript → **TypeScript**
- **Styling** — SCSS + Element theme → **Vanilla CSS + CSS custom properties**
- **Engine management** — Node.js `child_process` → **Tauri sidecar**
- **Build** — electron-builder → **Vite + Cargo**

Version numbering has been reset to reflect this clean break. The i18n translations (25+ languages), aria2 RPC protocol support, and overall UX philosophy have been preserved.

## Features

- **Multi-protocol downloads** — HTTP, FTP, BitTorrent, Magnet links
- **BitTorrent** — Selective file download, DHT, peer exchange, encryption
- **Tracker management** — Auto-sync from community tracker lists
- **Concurrent downloads** — Up to 10 tasks with configurable thread count
- **Speed control** — Global and per-task upload/download limits
- **System tray** — Real-time speed display in the menu bar (macOS)
- **Dark mode** — Native dark theme as default
- **Task management** — Pause, resume, delete with file cleanup, batch operations
- **Download protocols** — Register as default handler for magnet and thunder links
- **Notifications** — System notifications on task completion
- **Lightweight** — Tauri-based, minimal resource footprint

## Installation

Download the latest release from [GitHub Releases](https://github.com/AnInsomniacy/motrix-next/releases).

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)

### Setup

```bash
# Clone the repository
git clone https://github.com/AnInsomniacy/motrix-next.git
cd motrix-next

# Install frontend dependencies
pnpm install

# Start development server (launches Tauri + Vite)
pnpm tauri dev

# Build for production
pnpm tauri build
```

### Project Structure

```
motrix-next/
├── src/                    # Frontend (Vue 3 + TypeScript)
│   ├── api/                # Aria2 RPC client
│   ├── components/         # Vue components
│   ├── shared/             # Constants, utilities, i18n locales
│   ├── stores/             # Pinia state management
│   └── views/              # Page-level views
├── src-tauri/              # Backend (Rust + Tauri)
│   ├── src/                # Tauri commands, engine management, tray/menu
│   └── binaries/           # Aria2 sidecar binary
└── package.json
```

### Versioning

`Cargo.toml` is the single source of truth for the application version. `tauri.conf.json` omits the `version` field intentionally — Tauri reads it from `Cargo.toml` at build time, and the About panel reads it via `getVersion()` at runtime.

To bump the version, edit only `src-tauri/Cargo.toml`:

```toml
version = "1.1.0"
```

### Release

Pushing a version tag triggers the CI pipeline which builds for all supported platforms:

```bash
git tag v1.1.0
git push origin v1.1.0
```

| Platform | Runner | Artifacts |
|----------|--------|-----------|
| macOS ARM64 | `macos-latest` | `.dmg` |
| Windows x64 | `windows-latest` | `.exe` (NSIS) |
| Linux x64 | `ubuntu-latest` | `.AppImage` + `.deb` |
| Linux ARM64 | `ubuntu-24.04-arm` | `.AppImage` + `.deb` |

The workflow creates a draft release with all artifacts and a `latest.json` manifest for in-app auto-updates.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Tauri 2](https://v2.tauri.app/) |
| Frontend | [Vue 3](https://vuejs.org/) (Composition API) |
| State | [Pinia](https://pinia.vuejs.org/) |
| UI | [Naive UI](https://www.naiveui.com/) |
| Language | TypeScript + Rust |
| Build | Vite + Cargo |
| Engine | [Aria2](https://aria2.github.io/) |

## Acknowledgements

- [Motrix](https://github.com/agalwood/Motrix) by [agalwood](https://github.com/agalwood) and all its contributors
- [Aria2](https://aria2.github.io/) — the powerful download engine at the core

## License

[MIT](https://opensource.org/licenses/MIT) — Copyright (c) 2025-present AnInsomniacy
