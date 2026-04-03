# ⚡ RoshiLABX

**Personal Home Lab SSH Manager** — Native Electron desktop app with real SSH, xterm.js terminal, Kubernetes shortcuts, and 7 color themes.

---

## 🚀 Quick Start

**Requirements:** Node.js v18+ → https://nodejs.org

### Linux / macOS
```bash
chmod +x setup.sh
./setup.sh
```

### Windows
```
Double-click  setup.bat
```

### Manual
```bash
npm install
npm start
```

---

## ✨ What Works

| Feature | Notes |
|---------|-------|
| ✅ Real SSH (password) | Works out of the box |
| ✅ Real SSH (private key) | Click Browse to pick your key file |
| ✅ xterm.js terminal | Full ANSI, colors, mouse |
| ✅ Multiple tabs | Each tab = independent SSH connection |
| ✅ Session manager | Saved to disk, persists restarts |
| ✅ Test Connection | Before saving any session |
| ✅ 7 Color themes | Live-switching, no restart needed |
| ✅ K8s quick commands | Sends kubectl/helm cmds to active terminal |
| ✅ Font, cursor, opacity | Live-updating |
| ✅ Reconnect / Duplicate | In connection bar |

---

## 🔒 SSH Auth

**Password:** Enter host, port, username, password → Save & Connect

**Private Key:**
1. Switch to "🗝 Private Key" tab in the session dialog
2. Click **Browse…** → select your key (`.pem`, `id_rsa`, etc.)
3. Enter passphrase if protected
4. Save & Connect

---

## 🏗 Build Installer

```bash
npm install --save-dev electron-builder   # first time only
npm run build:win    # Windows .exe
npm run build:mac    # macOS .dmg
npm run build:linux  # Linux .AppImage
```

---

## 🐛 Troubleshooting

**Blank screen / app won't load**
→ Make sure you have an internet connection on first launch (xterm.js loads from CDN)
→ Or run offline: `npm install xterm xterm-addon-fit` then update the script paths

**"ECONNREFUSED"**
→ SSH not running on target: `sudo systemctl start ssh`

**"Authentication failed"**
→ Double-check username/password, or verify key permissions: `chmod 600 ~/.ssh/id_rsa`

**npm warn about msvs-version**
→ Safe to ignore — it's a Windows build tool warning, doesn't affect the app
