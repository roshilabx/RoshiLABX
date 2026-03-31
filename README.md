# RoshiLABX

<div align="center">

**Your personal home lab SSH manager**

*A cyberpunk-themed Electron desktop application for managing SSH sessions,*
*local terminals, and Kubernetes dashboards — built for home lab engineers.*

[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com)
[![Electron](https://img.shields.io/badge/Electron-28.x-47848F?style=flat-square)](https://electronjs.org)
[![Node](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-cyan?style=flat-square)](LICENSE)

</div>

---

## Features

### SSH Management
- Save and manage multiple SSH sessions (password or private key auth)
- MobaxTerm-style host key verification — trust prompt on first connect, fingerprint stored locally
- Host key mismatch detection — blocks connection if server key changes (MITM protection)
- Known hosts sync — shares trust store between RoshiLABX and Git Bash OpenSSH
- Multi-tab SSH sessions — open multiple connections simultaneously
- Reconnect, disconnect, and duplicate session tabs

### Local Terminal
- Embedded Git Bash terminal powered by node-pty (real PTY, same engine as VS Code)
- Password auto-save — detects SSH password prompts in terminal, offers to save for next time
- Auto-types saved passwords silently on future connections
- Full xterm.js rendering with mouse support, copy/paste, font resize

### Kubernetes Dashboard
- Live cluster overview with CPU/memory charts (Chart.js)
- Node status, pod list, namespace browser
- Quick kubectl command shortcuts

### UI and Themes
- Full glassmorphism across titlebar, sidebar, tabs, modals, and panels
- 12+ colour themes including Dracula, Nord, Monokai, Cyber, Midnight, Ocean and more
- Orbitron font logo with cyan to green gradient
- Drag-and-drop tab reordering
- Auto-hide sidebar with peek-on-hover

### Animated Wallpapers
| Theme | Description |
|-------|-------------|
| Matrix | Classic green rain (Latin + Katakana) |
| Cyber Grid | Perspective grid with scan line |
| Starfield | Warp-speed star field |
| Neon Pulse | Neon glow pulses |
| RoshiLABX | Branded animated logo |
| Ashoka | Ashokan Brahmi script rain — slow, readable, gold/amber |
| Ashoka Vega | Ashokan Brahmi script rain — Matrix speed, gold/amber |

The Ashoka themes use the complete authentic Ashokan Brahmi script (3rd century BCE) — the exact characters from Emperor Ashoka's rock edicts, rendered using the Noto Sans Brahmi font.

---

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| OS | Windows 10 / Windows 11 (64-bit) |
| RAM | 4GB (8GB recommended) |
| Disk | 500MB free space |
| Node.js | v18 LTS or v20 LTS |
| Git for Windows | Latest stable |

---

## Prerequisites

Install these before cloning the project. Each one is required.

### 1. Node.js (v18 or v20 LTS)

Download: https://nodejs.org/en/download

Choose the LTS version. During install, check "Add to PATH".

Verify:
```powershell
node -v
npm -v
```

### 2. Git for Windows

Download: https://git-scm.com/download/win

Install with all default options. This provides Git Bash terminal, git command line, and OpenSSH client.

Verify:
```powershell
git --version
```

### 3. Visual Studio Build Tools 2022

Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/

Click "Download Build Tools" then run the installer and select:
- Desktop development with C++
- Windows 10/11 SDK
- MSVC v143 build tools

This is required to compile node-pty which powers the Git Bash terminal. Without it the local terminal will not work.

After install, configure npm:
```powershell
npm config set msvs_version 2022
```

### 4. Python 3.x

Download: https://www.python.org/downloads/

During install check "Add Python to PATH".

Verify:
```powershell
python --version
```

### 5. Noto Sans Brahmi Font

Download: https://fonts.google.com/noto/specimen/Noto+Sans+Brahmi

Click "Download family", extract the zip, and copy NotoSansBrahmi-Regular.ttf into the fonts/ folder of the project.

---

## Installation and Running

### Step 1 — Clone the repository

```powershell
git clone https://github.com/roshilabx/RoshiLABX.git
cd RoshiLABX
```

### Step 2 — Add the Brahmi font

Create a fonts/ folder in the project root and place the font file inside:

```
RoshiLABX/
└── fonts/
    └── NotoSansBrahmi-Regular.ttf
```

### Step 3 — Install dependencies

```powershell
npm install
```

If you see errors about node-pty, make sure Visual Studio Build Tools are installed and retry.

### Step 4 — Run the app

```powershell
npm start
```

Or use the included batch file:

```powershell
.\run.bat
```

---

## Building a Windows Installer

To create a distributable .exe installer you must run as Administrator.

Right-click PowerShell and select "Run as Administrator", then:

```powershell
cd RoshiLABX

# Clear previous build cache
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -ErrorAction SilentlyContinue

# Build
npm run build:win
```

Or use the included script (run as Administrator):

```powershell
.\setup.bat
```

### Build Output

After a successful build the dist/ folder contains:

| File | Description |
|------|-------------|
| RoshiLABX Setup 1.0.0.exe | NSIS installer with Start Menu shortcut |
| RoshiLABX 1.0.0.exe | Portable executable, no install needed |

---

## Project Structure

```
RoshiLABX/
├── src/
│   ├── main.js              # Electron main process
│   │                        # SSH connections (ssh2)
│   │                        # Local PTY terminal (node-pty)
│   │                        # IPC handlers
│   │                        # Known hosts store and sync
│   │                        # Credential store
│   ├── preload.js           # Context bridge (secure IPC API)
│   └── renderer/
│       ├── index.html       # Full UI — CSS themes, wallpapers, modals
│       └── app.js           # Renderer logic
│                            # Session management
│                            # Tab system
│                            # Terminal rendering (xterm.js)
│                            # K8s dashboard and charts
│                            # Wallpaper animations
│                            # Settings and themes
├── assets/
│   └── icon.ico             # App icon (multi-size: 16 to 256px)
├── fonts/
│   └── NotoSansBrahmi-Regular.ttf
├── package.json
├── setup.bat                # Windows build script (run as Admin)
├── run.bat                  # Quick launch script
├── setup.sh                 # Linux/macOS launch script
└── README.md
```

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| electron | ^28.0.0 | Desktop app framework |
| node-pty | ^1.0.0 | Real PTY for Git Bash terminal |
| ssh2 | ^1.15.0 | SSH2 client for remote connections |
| xterm | ^5.3.0 | Terminal emulator |
| xterm-addon-fit | ^0.8.0 | Auto-resize terminal |
| xterm-addon-canvas | 0.6.0-beta.37 | Canvas renderer for xterm |

### Dev

| Package | Version | Purpose |
|---------|---------|---------|
| electron-builder | ^24.0.0 | Build Windows installer and portable |

---

## Data Storage

RoshiLABX stores all data locally. Nothing is sent to any external server.

Windows path: C:\Users\YourName\AppData\Roaming\roshilabx\

| File | Contents |
|------|----------|
| sessions.json | Saved SSH sessions |
| settings.json | UI preferences, theme, wallpaper |
| known_hosts.json | Trusted SSH host fingerprints |
| known_hosts | OpenSSH-format known hosts |
| credentials.json | Saved SSH passwords |
| ssh/config | Generated SSH config for Git Bash |
| ssh_keys/ | Generated ED25519 key pairs |

---

## Security

### Host Key Verification
- First connection shows a trust dialog with the server SHA256 fingerprint
- Accepted keys saved permanently
- Key mismatch blocks connection with a warning (possible MITM attack)

### Known Hosts Sync
- Trust a host in RoshiLABX — Git Bash trusts it too
- Trust a host in Git Bash — RoshiLABX trusts it too

### Password Storage
- Passwords stored only in local credentials.json
- Never transmitted anywhere

---

## Troubleshooting

### node-pty fails to compile
```powershell
npm config set msvs_version 2022
npm install
```

### Git Bash terminal shows PowerShell instead
Install Git for Windows from https://git-scm.com/download/win and restart the app.

### Build fails with "Cannot create symbolic link"
Run PowerShell as Administrator before running npm run build:win.

### Icon shows default Electron flask after install
```powershell
# Run as Administrator
taskkill /IM explorer.exe /F
Remove-Item -Force "$env:LOCALAPPDATA\IconCache.db" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*" -ErrorAction SilentlyContinue
Start-Process explorer.exe
```

### xterm-addon-canvas version not found
Ensure package.json has exactly:
```json
"xterm-addon-canvas": "0.6.0-beta.37"
```

### SSH connection times out
- Check the server firewall allows port 22
- Verify sshd is running: sudo systemctl status sshd
- Run ssh -v user@host in Git Bash for verbose debug output

---

## Roadmap

- [ ] SCP file transfer panel
- [ ] SSH key-based passwordless login
- [ ] Session groups and folders in sidebar
- [ ] Multi-hop SSH jump host support
- [ ] Terminal split view
- [ ] Linux and macOS support

---

## Author

**Roshan** (𑀭𑁄𑀰𑀦)

Built with love for home lab enthusiasts who live in the terminal.

---

*"The journey of a thousand servers begins with a single SSH connection."*
