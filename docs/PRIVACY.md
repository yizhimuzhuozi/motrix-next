# Privacy Policy

**Last updated:** 2026-04-23

Motrix Next is an open-source desktop download manager licensed under the [MIT License](https://opensource.org/licenses/MIT). This document describes what data the application handles and what network connections it makes.

## Data Collection

Motrix Next does **not** collect, store, or transmit any personal data, usage analytics, or telemetry. There is no account system, no tracking, and no third-party analytics SDK.

## Local Data Storage

All user data is stored locally on your device and is never synced to any remote server:

| Data | Location | Purpose |
|------|----------|---------|
| Preferences | `config.json` (app data directory) | User settings |
| Download history | `history.db` (local SQLite database) | Task records |
| Download files | User-specified directory | Downloaded content |
| Aria2 session | `aria2.session` (app data directory) | Resume state |

## Automatic Network Connections

Motrix Next makes the following network connections automatically. **All can be disabled in Settings.**

### 1. Update Check

| | |
|---|---|
| **Default** | Enabled (every 24 hours) |
| **Contacts** | GitHub Releases API (`github.com`) |
| **Purpose** | Check if a newer version of Motrix Next is available |
| **Data sent** | Current app version, platform, and architecture |
| **Data received** | Latest version metadata |
| **Disable** | Settings → General → uncheck *"Auto check for updates"* |

### 2. BT Tracker List Sync

| | |
|---|---|
| **Default** | Enabled |
| **Contacts** | Community tracker list URLs (e.g. `cdn.jsdelivr.net`) |
| **Purpose** | Update BitTorrent tracker lists for better peer discovery |
| **Data sent** | Standard HTTP GET request (no user data) |
| **Data received** | Plain-text tracker URL list |
| **Disable** | Settings → BitTorrent → uncheck *"Auto sync tracker list"* |

## User-Initiated Network Connections

When you add a download task, the application connects to the servers or peers you specify (HTTP/FTP servers, BitTorrent trackers, DHT nodes, etc.) to perform the download. These connections are inherent to the download manager's core functionality and only occur when you explicitly add a task.

## Third-Party Components

| Component | Purpose | Network behavior |
|-----------|---------|-----------------|
| [aria2](https://aria2.github.io/) | Download engine | Connects to download servers and BitTorrent peers as directed by the user |
| [DB-IP](https://db-ip.com/) | GeoIP database (CC BY 4.0) | **Offline only** — bundled database, no network requests |
| [Tauri Updater Plugin](https://github.com/tauri-apps/plugins-workspace) | Auto-update framework | Used for the update check described above |

## Children's Privacy

Motrix Next does not knowingly collect any data from children or any other users. The application does not collect data from anyone.

## Changes to This Policy

Updates to this privacy policy will be posted in this file within the project's GitHub repository. The "Last updated" date at the top will be revised accordingly.

## Contact

For privacy-related questions, please open an issue on GitHub:
https://github.com/AnInsomniacy/motrix-next/issues
