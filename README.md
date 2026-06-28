
# LANChat

> A cross-platform, no-registration LAN chat app with file transfer support.
>
> 📖 [中文文档](README_CN.md)

<img width="1923" height="2104" alt="LANChat screenshot" src="https://github.com/user-attachments/assets/454c170a-272a-4997-b096-569fc7c4dc53" />

## Features

- 🚀 **No Registration** - Auto-generates random usernames; click to change anytime
- 💻 **Cross-Platform** - Linux desktop, Windows desktop, Android App, Web
- 🔍 **Auto Discovery** - UDP broadcast/multicast based LAN device discovery
- 🔗 **Manual Discovery** - Add by IP, domain, or hostname; works across VLANs / WireGuard
- 🔄 **Smart Reply** - Auto-replies to heartbeats; only one side needs to add the other for mutual discovery
- 💬 **Real-time Chat** - Text messages, streaming messages, and file transfer
- 📁 **File Transfer** - Large file chunked transfer with configurable auto-accept
- 📸 **Image Preview** - Automatic preview for image messages
- 💾 **History** - SQLite database for chat history
- 🔧 **Port Config** - Customizable service port in settings, overridable via CLI
- 📂 **Database Path** - Custom database location, persisted in config file
- 🌐 **Web Client** - Deployable on headless servers
- 🔔 **System Notifications** - Linux desktop, Windows desktop, Android App, Web
- 💡 **Tray Icon Flash** - Click to jump to latest unread; right-click menu to toggle notifications
- 🌍 **i18n** - Automatic system language detection, manual switch, tray menu hot-reload
- 🤖 **[LANClaw](https://github.com/cap153/LANClaw) AI Bot** - Pi-powered AI chatbot with auto-reply, file analysis, and scheduled tasks
- 📱 **Android Dual-Track File Engine** — SAF persistable permissions + Share Intent FD cache zero-copy dual track
- 📁 **SAF File Picker** — Android native `ACTION_OPEN_DOCUMENT`; selected files remain readable across process/reboot
- 🔁 **Offline Re-send** — Offline messages auto-cached; auto-re-send on reconnect, including files
- 🔗 **Manual Receive** - Turn off **Auto Download** and click to download files manually

## Quick Start

### AUR

```bash
paru -S lanchat-bin
```

### Releases

[https://github.com/cap153/LANChat/releases](https://github.com/cap153/LANChat/releases)

### Build from Source

Prerequisites:

[https://v2.tauri.app/start/prerequisites/](https://v2.tauri.app/start/prerequisites/)

```bash
# Desktop Linux
cargo tauri build --bundles deb
cargo tauri build --bundles rpm

# Android APK
cargo tauri android build --target aarch64
./sign-apk.sh

# Windows desktop
cd src-tauri
cargo xwin build --release --bin lanchat --target x86_64-pc-windows-msvc

# Web (lightweight, no GUI dependencies)
cd src-tauri
cargo build --release --bin lanchat-web --features web --no-default-features
cargo build --no-default-features --features web --release --target x86_64-pc-windows-gnu # Windows web
```

Or use the Makefile for one-click builds:

```bash
make all          # Build all tested platforms
make deb          # Linux .deb
make rpm          # Linux .rpm
make apk          # Android APK (auto-signed)
make windows-desktop  # Windows desktop (requires cargo-xwin)
make web          # Web (Linux)
make web-windows  # Web (Windows)
make help         # Show help
```

## Running

1. Start the service (default port `8888`, configurable in settings):

```bash
# Desktop
lanchat

# Web
lanchat-web
```

CLI arguments `--port` and `--db-path` override config file settings with highest priority.

```bash
# Web / Desktop
lanchat --port 8889 --db-path /custom/path/lanchat.db
```

> [!TIP]
> Run multiple instances by specifying different ports and database paths.  
> Use the **Add** panel with `<IP>:<port>` to discover across ports.  
> Once one side receives a heartbeat, the reply mechanism enables mutual discovery.

2. Firewall configuration (ufw example):

> [!IMPORTANT]
> Ensure both TCP and UDP are allowed for the configured port.

```bash
# TCP: Web pages and WebSocket communication
sudo ufw allow 8888/tcp
# UDP: Device discovery (broadcast/multicast/heartbeat)
sudo ufw allow 8888/udp
```

## Custom Themes

Place custom `.css` files in the config directory (any filename):

- **Linux**: `~/.config/lanchat/`
- **Windows**: `%APPDATA%\.config\lanchat`

See built-in themes for reference: [https://github.com/cap153/LANChat/tree/main/src/css](https://github.com/cap153/LANChat/tree/main/src/css)

## Config File

Port, language, and other settings are stored in `config.json`. CLI arguments `--port` and `--db-path` take highest priority.

- **Linux**: `~/.config/lanchat/config.json`
- **Windows**: `%APPDATA%\lanchat\config.json`
- **macOS**: `~/Library/Application Support/lanchat/config.json`

Example content:

```json
{
  "db_path": null,
  "port": 8888,
  "lang": "en"
}
```

| Field     | Description                                       |
|-----------|---------------------------------------------------|
| `db_path` | [Database path](#database); `null` = default      |
| `port`    | Listening port, default 8888                      |
| `lang`    | Interface language: `zh` (Chinese), `en` (English) |

## Database

Desktop and Web share the same database:

- **Linux**: `~/.local/share/com.lanchat.app/lanchat.db`
- **Windows**: `%APPDATA%\com.lanchat.app\lanchat.db`

The database path can be changed in settings (requires restart). The path is stored in `~/.config/lanchat/config.json`.

## Feature Status

### ✅ Done

- [x] Auto-generated random usernames
- [x] Click username to rename
- [x] LAN device discovery (UDP broadcast/multicast)
- [x] Real-time online user list
- [x] Standalone Web deployment
- [x] Shared database between desktop and Web
- [x] Settings panel (port, db path, download path)
- [x] Chat history query
- [x] Theme switching
- [x] Android support
- [x] Text message transfer
- [x] File transfer
- [x] Windows support
- [x] Single instance lock
- [x] Streaming file transfer
- [x] Dynamic chunk size based on system memory
- [x] Broadcast and multicast support
- [x] Android hotspot random subnet brute-force
- [x] Web: click file message to download directly
- [x] Desktop: click file message to open containing folder
- [x] Android: receive shared files from other apps and send
- [x] Android: share file messages to other apps
- [x] Desktop & Web: drag-and-drop file sending
- [x] Desktop: paste file sending (zero-copy, Wayland-first)
- [x] Web: paste file sending
- [x] Auto image preview
- [x] Red dot for unread messages
- [x] Lazy-load history (scroll to trigger)
- [x] Delete chat history
- [x] Android: open file messages
- [x] Smart file deduplication (reuse identical files, auto-rename on conflict)
- [x] Offline message re-send on reconnect
- [x] Clipboard image paste sending
- [x] Delete offline users
- [x] Clear chat history
- [x] Android: status bar / navigation bar adaptation
- [x] [LANClaw](https://github.com/cap153/LANClaw) streaming AI replies
- [x] Model switching command (`/model`)
- [x] New session command (`/new`)
- [x] Manual discovery (IP / domain / hostname, cross-VLAN / WireGuard)
- [x] UDP heartbeat auto-reply (cross-port / cross-subnet auto discovery)
- [x] System notifications (desktop: PowerShell / notify-send, Web: Notification API, Android: native)
- [x] Tray icon flash (unread notification, click to jump to latest)
- [x] Notification toggle (tray right-click menu, desktop only)
- [x] Manual file receive
- [x] Android SAF persistable permissions + zero-copy FD cache dual-track
- [x] Android SAF native file picker (`ACTION_OPEN_DOCUMENT` + `takePersistableUriPermission`)
- [x] Real-time file transfer speed display
- [x] Platform-standard config paths (Linux `~/.config/`, Windows `%APPDATA%`)
- [x] i18n (auto-detect + manual switch + tray hot-reload)

### 🚧 In Progress

- [ ] Group chat
- [ ] Better default icon

## Project Structure

```
LANChat/
├── src/                      # Frontend
│   ├── css/
│   │   ├── style.css        # Main stylesheet
│   │   └── vscode.css       # VSCode theme
│   ├── js/
│   │   ├── api.js           # API wrapper (Tauri + HTTP dual backend)
│   │   ├── app.js           # App logic
│   │   └── ui.js            # UI interactions
│   └── index.html           # Main page
├── src-tauri/               # Backend (desktop + Web)
│   ├── src/
│   │   ├── main.rs          # Desktop Tauri entry
│   │   ├── server_main.rs   # Web standalone entry
│   │   ├── lib.rs           # Android entry
│   │   ├── commands.rs      # Tauri commands
│   │   ├── web_server.rs    # HTTP/WebSocket server
│   │   ├── db.rs            # SQLite database logic
│   │   ├── config_file.rs   # Config file read/write
│   │   ├── peers.rs         # Online user manager
│   │   ├── models.rs        # Data models
│   │   ├── utils.rs         # Utilities
│   │   └── network/         # Network module
│   │       ├── discovery.rs # UDP device discovery
│   │       └── messaging.rs # WebSocket messaging
│   ├── capabilities/        # Tauri capability config
│   ├── permissions/         # Custom command permissions
│   └── Cargo.toml
├── Makefile                 # One-click build
└── README.md                # This file
```

## File Status Reference

| Role         | Status Value                 | Display Text |
|--------------|------------------------------|--------------|
| **Sender**   | `status: "pending"`          | pending      |
| **Sender**   | `file_status: "offering"`    | offering     |
| **Sender**   | `file_status: "uploading"`   | xx MB/s      |
| **Sender**   | `file_status: "sent"`        | (empty)      |
| **Receiver** | `file_status: "offered"`     | offered      |
| **Receiver** | `file_status: "invalid"`     | invalid      |
| **Receiver** | `file_status: "downloading"` | xx MB/s      |
| **Receiver** | `file_status: "accepted"`    | (empty)      |

## Troubleshooting

**Windows: missing `VCRUNTIME140.dll` / `VCRUNTIME140_1.dll`:**  
[https://aka.ms/vs/17/release/vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)  
[https://aka.ms/vs/17/release/vc_redist.x86.exe](https://aka.ms/vs/17/release/vc_redist.x86.exe)

**Windows: WebView2 not installed:**  
[https://developer.microsoft.com/en-us/microsoft-edge/webview2](https://developer.microsoft.com/en-us/microsoft-edge/webview2)

**Online user sends messages but they show as `Pending` on my side:**  
Disable mobile data / VPN and reconnect to WiFi.

**Cross-VLAN / WireGuard:**

When devices are on different VLANs or connected via WireGuard, UDP broadcast won't cross subnets. Solution: use the **Add** panel to enter the peer's IP/domain/hostname with port. The system sends unicast heartbeats periodically (DNS resolution supported, 60s cache).

> [!TIP]
> Only one side needs to add the other. Upon receiving a heartbeat, the peer **auto-replies** with its own heartbeat, enabling mutual discovery without manual setup on both sides.
> Reply heartbeats include a `|1` marker to prevent infinite loops.

## Tech Stack

- **Backend**: Rust + Tauri 2.0
- **Frontend**: Vanilla HTML + CSS + JavaScript
- **Database**: SQLite (sqlx)
- **Network**: UDP broadcast/multicast + TCP/WebSocket + HTTP chunked upload
- **Web Server**: Axum
- **AI Bot**: [LANClaw](https://github.com/cap153/LANClaw) (separate process, driven by Pi RPC)

## License

MIT License

## Acknowledgements

- [Tauri](https://tauri.app/) - Cross-platform app framework
- [Axum](https://github.com/tokio-rs/axum) - Web framework
- [SQLx](https://github.com/launchbadge/sqlx) - Async SQL toolkit

## Sponsor

If you find this project helpful, feel free to buy me a coffee ☕️

<details>
  <summary><b>Click to reveal QR code (WeChat Pay)</b></summary>
  <br />
  <p align="center">
    <img src=".github/wechat_sponsor.png" width="250" />
    <br />
  </p>
  <p align="center">Your support is greatly appreciated!</p>
</details>
