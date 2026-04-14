'use strict';

// ─── Logger (must be first — captures crashes too) ────────────────────────────
const _fs   = require('fs');
const _path = require('path');
const _os   = require('os');

// We can't use app.getPath yet (app not ready), so build the path manually
const _logDir  = _path.join(_os.homedir(), 'AppData', 'Roaming', 'roshilabx', 'logs');
const _logFile = _path.join(_logDir, 'roshilabx.log');
const _MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB max, then rotate

function _ensureLogDir() {
  try { _fs.mkdirSync(_logDir, { recursive: true }); } catch(e) {}
}

function _rotateLog() {
  try {
    const stat = _fs.statSync(_logFile);
    if (stat.size > _MAX_LOG_BYTES) {
      const backup = _logFile.replace('.log', '.old.log');
      if (_fs.existsSync(backup)) _fs.unlinkSync(backup);
      _fs.renameSync(_logFile, backup);
    }
  } catch(e) {}
}

function log(level, category, message, data) {
  _ensureLogDir();
  _rotateLog();
  const ts   = new Date().toISOString();
  const meta = data ? ' ' + JSON.stringify(data) : '';
  const line = `[${ts}] [${level}] [${category}] ${message}${meta}\n`;
  try { _fs.appendFileSync(_logFile, line, 'utf8'); } catch(e) {}
  // Also print to console for dev mode
  if (level === 'ERROR' || level === 'CRASH') console.error(line.trim());
  else console.log(line.trim());
}

const logger = {
  info:  (cat, msg, data) => log('INFO',  cat, msg, data),
  warn:  (cat, msg, data) => log('WARN',  cat, msg, data),
  error: (cat, msg, data) => log('ERROR', cat, msg, data),
  crash: (cat, msg, data) => log('CRASH', cat, msg, data),
  debug: (cat, msg, data) => log('DEBUG', cat, msg, data),
};

process.on('uncaughtException', err => {
  logger.crash('PROCESS', 'Uncaught exception — app will exit', { message: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('PROCESS', 'Unhandled promise rejection', { reason: String(reason) });
});

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// ─── Persistent storage (no external deps) ───────────────────────────────────
const DATA_DIR      = app.getPath('userData');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) {
    if (e.code !== 'ENOENT') logger.warn('STORAGE', 'readJSON failed', { file, error: e.message });
    return fallback;
  }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { logger.error('STORAGE', 'writeJSON failed', { file, error: e.message }); }
}

// ─── Known Hosts (SSH host key store) ────────────────────────────────────────
const KNOWN_HOSTS_FILE    = path.join(DATA_DIR, 'known_hosts.json');
const OPENSSH_KH_FILE     = path.join(DATA_DIR, 'known_hosts');       // OpenSSH format (for ssh2 sync)
const USER_KH_FILE        = path.join(os.homedir(), '.ssh', 'known_hosts'); // where OpenSSH actually writes

function readKnownHosts() {
  return readJSON(KNOWN_HOSTS_FILE, {});
}
function writeKnownHosts(data) {
  writeJSON(KNOWN_HOSTS_FILE, data);
}
function getHostKey(host, port) {
  const hosts = readKnownHosts();
  return hosts[`${host}:${port}`] || null;
}
function saveHostKey(host, port, fingerprint, keyType) {
  const hosts = readKnownHosts();
  hosts[`${host}:${port}`] = { fingerprint, keyType, savedAt: new Date().toISOString() };
  writeKnownHosts(hosts);
  syncToOpenSSH();
}
function removeHostKey(host, port) {
  const hosts = readKnownHosts();
  delete hosts[`${host}:${port}`];
  writeKnownHosts(hosts);
  syncToOpenSSH();
}

// Convert our JSON store → OpenSSH known_hosts format so Git Bash OpenSSH trusts the same hosts
function syncToOpenSSH() {
  // We only write placeholder lines — the real key material comes from OpenSSH itself.
  // Instead we just ensure the file exists so GIT_SSH_COMMAND can reference it.
  // The actual sync direction is: OpenSSH → our JSON (via file watcher below).
  try {
    if (!fs.existsSync(OPENSSH_KH_FILE)) fs.writeFileSync(OPENSSH_KH_FILE, '', 'utf8');
  } catch(e) { console.error('syncToOpenSSH error:', e); }
}

// Parse OpenSSH known_hosts lines and merge into our JSON store
function syncFromOpenSSH() {
  try {
    if (!fs.existsSync(USER_KH_FILE)) return;
    const lines = fs.readFileSync(USER_KH_FILE, 'utf8').split('\n');
    const hosts = readKnownHosts();
    let changed = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // OpenSSH format: "hostname keytype base64key" or "[hostname]:port keytype base64key"
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const hostField = parts[0];
      const keyType   = parts[1];
      const keyData   = parts[2];

      // Parse host and port
      let host, port;
      const bracketMatch = hostField.match(/^\[(.+)\]:(\d+)$/);
      if (bracketMatch) {
        host = bracketMatch[1];
        port = parseInt(bracketMatch[2], 10);
      } else {
        host = hostField;
        port = 22;
      }

      const key = `${host}:${port}`;
      // Compute a fingerprint from the raw base64 key material
      const crypto = require('crypto');
      const fingerprint = 'SHA256:' + crypto.createHash('sha256')
        .update(Buffer.from(keyData, 'base64')).digest('base64');

      if (!hosts[key]) {
        hosts[key] = { fingerprint, keyType, savedAt: new Date().toISOString(), source: 'gitbash' };
        changed = true;
      }
    }
    if (changed) writeKnownHosts(hosts);
  } catch(e) { console.error('syncFromOpenSSH error:', e); }
}

// Watch the user's ~/.ssh/known_hosts for changes made by Git Bash SSH
let khWatcher = null;
function startKnownHostsWatcher() {
  // Ensure ~/.ssh dir exists
  try {
    const sshDir = path.join(os.homedir(), '.ssh');
    fs.mkdirSync(sshDir, { recursive: true });
    if (!fs.existsSync(USER_KH_FILE)) {
      fs.writeFileSync(USER_KH_FILE, '', 'utf8');
    }
    // Also ensure our DATA_DIR known_hosts exists for ssh2 sync
    if (!fs.existsSync(OPENSSH_KH_FILE)) {
      fs.writeFileSync(OPENSSH_KH_FILE, '', 'utf8');
    }
    console.log('[RoshiLABX] Watching', USER_KH_FILE);
  } catch(e) { console.error('known_hosts init error:', e); }

  try {
    khWatcher = fs.watch(USER_KH_FILE, () => {
      setTimeout(syncFromOpenSSH, 200);
    });
  } catch(e) { console.error('khWatcher error:', e); }

  // Sync any existing entries on startup
  syncFromOpenSSH();
}

// ─── Credentials store (safeStorage-encrypted — like MobaXterm) ──────────────
// Uses Electron safeStorage → Windows DPAPI. No plaintext passwords on disk.
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');

let _safeStorage = null;
function getSafeStorage() {
  if (_safeStorage) return _safeStorage;
  try { const { safeStorage } = require('electron'); _safeStorage = safeStorage; return _safeStorage; }
  catch(e) { logger.warn('CREDS', 'safeStorage unavailable', { error: e.message }); return null; }
}

function encryptPassword(plaintext) {
  const ss = getSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) {
    logger.warn('CREDS', 'Encryption unavailable — storing unencrypted');
    return { enc: false, value: plaintext };
  }
  try { return { enc: true, value: ss.encryptString(plaintext).toString('base64') }; }
  catch(e) { logger.error('CREDS', 'encryptString failed', { error: e.message }); return { enc: false, value: plaintext }; }
}

function decryptPassword(stored) {
  if (!stored) return '';
  if (!stored.enc) return stored.value || stored.password || '';
  const ss = getSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) return stored.value || '';
  try { return ss.decryptString(Buffer.from(stored.value, 'base64')); }
  catch(e) { logger.error('CREDS', 'decryptString failed — re-save credential', { error: e.message }); return ''; }
}

function readCredentials() { return readJSON(CREDENTIALS_FILE, {}); }

function saveCredential(user, host, port, password) {
  const creds = readCredentials();
  const encrypted = encryptPassword(password);
  creds[`${user}@${host}:${port}`] = { ...encrypted, savedAt: new Date().toISOString() };
  writeJSON(CREDENTIALS_FILE, creds);
  logger.info('CREDS', 'Credential saved', { user, host, port, encrypted: encrypted.enc });
}

function getDecryptedCredential(user, host, port) {
  const entry = readCredentials()[`${user}@${host}:${port}`];
  return entry ? decryptPassword(entry) : null;
}

function deleteCredential(user, host, port) {
  const creds = readCredentials();
  delete creds[`${user}@${host}:${port}`];
  writeJSON(CREDENTIALS_FILE, creds);
  logger.info('CREDS', 'Credential deleted', { user, host, port });
}

// ── One-time migration: encrypt legacy plaintext passwords in sessions.json ───
function migrateLegacySessions() {
  try {
    const ss = getSafeStorage();
    if (!ss || !ss.isEncryptionAvailable()) return;
    const sessions = readJSON(SESSIONS_FILE, []);
    let changed = false;
    for (const s of sessions) {
      if (s.password && typeof s.password === 'string' && !s._pwdEncrypted) {
        const enc = encryptPassword(s.password);
        s.password = enc.value; s._pwdEncrypted = enc.enc; changed = true;
      }
    }
    if (changed) { writeJSON(SESSIONS_FILE, sessions); logger.info('CREDS', 'Migrated legacy plaintext passwords'); }
  } catch(e) { logger.warn('CREDS', 'Session migration failed (non-fatal)', { error: e.message }); }
}

function getSessionPassword(s) {
  if (!s?.password) return undefined;
  if (s._pwdEncrypted === false || s._pwdEncrypted === undefined) return s.password;
  return decryptPassword({ enc: s._pwdEncrypted, value: s.password });
}
const connections = new Map();

// ─── Window ──────────────────────────────────────────────────────────────────
let win;

function createWindow() {
  win = new BrowserWindow({
    width:  1300,
    height: 820,
    minWidth:  960,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#0c0c0c',
    roundedCorners: false,
    thickFrame: false,
    icon: path.join(__dirname, '../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  Menu.setApplicationMenu(null);

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('closed', () => {
    connections.forEach(({ client }) => { try { client.end(); } catch {} });
    win = null;
  });
}

app.whenReady().then(() => {
  logger.info('APP', 'RoshiLABX starting', { version: app.getVersion(), platform: process.platform, node: process.version });
  createWindow();
  startKnownHostsWatcher();
  migrateLegacySessions(); // one-time migration: encrypt any legacy plaintext passwords
  logger.info('APP', 'Window created, known hosts watcher started');
});

// Clipboard IPC handlers using Electron's native clipboard
const { clipboard } = require('electron');
ipcMain.handle('clipboard:read',  () => clipboard.readText());
ipcMain.handle('clipboard:write', (_, text) => { clipboard.writeText(text); return true; });

// ─── Logger IPC — renderer can write to log and open log file ─────────────────
ipcMain.handle('log:write', (_, { level, category, message, data }) => {
  log(level || 'INFO', category || 'RENDERER', message, data);
  return true;
});
ipcMain.handle('log:open', () => {
  shell.openPath(_logFile);
  return true;
});
ipcMain.handle('log:path', () => _logFile);

app.on('window-all-closed', () => {
  logger.info('APP', 'All windows closed — quitting');
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (!win) createWindow(); });

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('win:min',   () => win?.minimize());
ipcMain.on('win:max',   () => win?.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('win:close', () => win?.close());
ipcMain.handle('win:opacity', (_, val) => { win?.setOpacity(Math.max(0.1, Math.min(1, val))); return true; });
ipcMain.handle('win:get-opacity', () => win?.getOpacity() ?? 1);

// ─── Sessions & settings ──────────────────────────────────────────────────────
ipcMain.handle('sessions:load', () => {
  const raw = readJSON(SESSIONS_FILE, []);
  // Decrypt passwords before sending to renderer — renderer always works with plaintext
  const result = raw.map(s => ({
    ...s,
    password: s.password ? getSessionPassword(s) : undefined,
    _pwdEncrypted: undefined,
  }));
  logger.debug('STORAGE', 'Sessions loaded', { count: result.length });
  return result;
});
ipcMain.handle('sessions:save', (_, d) => {
  // Encrypt passwords before writing to disk
  const toSave = d.map(s => {
    if (s.password && s.authType === 'password') {
      const enc = encryptPassword(s.password);

      // ── Mirror into credentials.json so Git Bash PTY auto-fill works ─────────
      // When user saves/edits a session with a password, that same credential
      // is stored in the credentials store so that typing 'ssh user@host' in
      // Git Bash terminal will auto-inject it — no re-prompting.
      saveCredential(s.username, s.host, parseInt(s.port) || 22, s.password);
      logger.debug('CREDS', 'Mirrored session credential to credentials store', {
        user: s.username, host: s.host, port: s.port
      });

      return { ...s, password: enc.value, _pwdEncrypted: enc.enc };
    }
    return s;
  });
  writeJSON(SESSIONS_FILE, toSave);
  logger.debug('STORAGE', 'Sessions saved (passwords encrypted)', { count: toSave.length });
  return true;
});
ipcMain.handle('settings:load', () => {
  const s = readJSON(SETTINGS_FILE, { theme: 'default', fontSize: 13, cursorStyle: 'block', opacity: 100 });
  logger.debug('STORAGE', 'Settings loaded', { theme: s.theme });
  return s;
});
ipcMain.handle('settings:save', (_, d) => { writeJSON(SETTINGS_FILE, d); return true; });

// ─── Browse private key ────────────────────────────────────────────────────────
ipcMain.handle('dialog:key', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select SSH Private Key',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile'],
    filters: [{ name: 'Key files', extensions: ['pem', 'ppk', 'key', 'pub', '*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  try {
    return { filePath: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
  } catch (e) {
    return { error: e.message };
  }
});

// ─── SSH Connect ──────────────────────────────────────────────────────────────
ipcMain.handle('ssh:connect', async (event, cfg) => {
  const { tabId, host, port, username, password, privateKey, passphrase } = cfg;

  logger.info('SSH', 'Connection attempt', { tabId, host, port: parseInt(port,10)||22, username });

  // Close existing connection on this tabId if any
  if (connections.has(tabId)) {
    logger.info('SSH', 'Closing existing connection on tabId', { tabId });
    try { connections.get(tabId).client.end(); } catch {}
    connections.delete(tabId);
  }

  let Client;
  try {
    Client = require('ssh2').Client;
  } catch (e) {
    return { ok: false, error: 'ssh2 not installed — run: npm install' };
  }

  return new Promise((resolve) => {
    const client = new Client();

    const authCfg = {
      host,
      port: parseInt(port, 10) || 22,
      username,
      readyTimeout: 120000,
      keepaliveInterval: 20000,
      keepaliveCountMax: 5,
    };

    if (privateKey) {
      authCfg.privateKey = privateKey;
      if (passphrase) authCfg.passphrase = passphrase;
    } else {
      authCfg.password = password;
    }

    // Keyboard-interactive fallback (some servers require it)
    authCfg.tryKeyboard = true;

    // ── Host key verification ──────────────────────────────────────────────────
    authCfg.hostVerifier = (keyInfo, callback) => {
      const crypto = require('crypto');
      const keyBuffer = keyInfo.getPublicSSH ? keyInfo.getPublicSSH() : keyInfo;
      const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64');
      const keyType = keyInfo.type || 'unknown';
      const portNum = parseInt(port, 10) || 22;
      const saved = getHostKey(host, portNum);

      if (saved) {
        if (saved.fingerprint === fingerprint) {
          logger.info('HOSTKEY', 'Fingerprint matched — trusted', { host, port: portNum, keyType });
          callback(true);
        } else {
          // ── Auto-clean stale key (VM recreated) and trust new key silently ──
          logger.warn('HOSTKEY', 'Fingerprint mismatch — VM likely recreated, auto-updating key', {
            host, port: portNum, old: saved.fingerprint, new: fingerprint
          });
          removeHostKey(host, portNum);
          saveHostKey(host, portNum, fingerprint, keyType);
          // Notify terminal so user sees what happened
          win?.webContents.send('ssh:data', {
            tabId,
            data: `\r\n\x1b[33m⚠ Host key changed (VM recreated?) — key updated automatically.\x1b[0m\r\n`
          });
          callback(true);
        }
        return;
      }

      // ── Unknown host — auto-trust and save (first connect) ──
      logger.info('HOSTKEY', 'Unknown host — auto-trusting on first connect', { host, port: portNum, keyType, fingerprint });
      saveHostKey(host, portNum, fingerprint, keyType);
      win?.webContents.send('ssh:data', {
        tabId,
        data: `\r\n\x1b[36mℹ Host key saved for ${host}:${portNum} [${keyType}]\x1b[0m\r\n`
      });
      callback(true);
    };

    client.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish([password || '']);
    });

    client.on('ready', () => {
      logger.info('SSH', 'Connection established', { tabId, host, username });
      client.shell(
        { term: 'xterm-256color', cols: 220, rows: 50 },
        (err, stream) => {
          if (err) {
            logger.error('SSH', 'Shell open failed', { tabId, host, error: err.message });
            client.end();
            return resolve({ ok: false, error: err.message });
          }

          connections.set(tabId, { client, stream });

          stream.on('data', (data) => {
            win?.webContents.send('ssh:data', { tabId, data: data.toString() });
          });
          stream.stderr.on('data', (data) => {
            win?.webContents.send('ssh:data', { tabId, data: data.toString() });
          });
          stream.on('close', () => {
            logger.info('SSH', 'Stream closed', { tabId, host });
            connections.delete(tabId);
            win?.webContents.send('ssh:closed', { tabId });
          });

          resolve({ ok: true });
        }
      );
    });

    client.on('error', (err) => {
      logger.error('SSH', 'Connection error', { tabId, host, error: err.message, code: err.code });
      connections.delete(tabId);

      let friendlyMsg = err.message;
      if (err.code === 'ETIMEDOUT' || err.message.includes('Timed out')) {
        friendlyMsg = `Connection timed out — is the VM running?\n  Host: ${host}:${parseInt(port,10)||22}`;
      } else if (err.code === 'ECONNREFUSED') {
        friendlyMsg = `Connection refused — SSH service may not be started on ${host}:${parseInt(port,10)||22}`;
      } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        friendlyMsg = `Host not found: ${host} — check IP or hostname`;
      } else if (/auth|Authentication/i.test(err.message)) {
        friendlyMsg = `Authentication failed for ${username}@${host} — check saved password`;
      }

      resolve({ ok: false, error: friendlyMsg });
    });

    try {
      client.connect(authCfg);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});

// ─── SSH Send input ────────────────────────────────────────────────────────────
ipcMain.on('ssh:input', (_, { tabId, data }) => {
  const conn = connections.get(tabId);
  if (conn?.stream) {
    try { conn.stream.write(data); } catch (e) { console.error('ssh:input', e); }
  }
});

// ─── Known Hosts management ───────────────────────────────────────────────────
ipcMain.handle('ssh:known-hosts:list', () => readKnownHosts());
ipcMain.handle('ssh:known-hosts:remove', (_, { host, port }) => {
  logger.info('HOSTKEY', 'Host key manually removed', { host, port });
  removeHostKey(host, parseInt(port, 10) || 22);
  return { ok: true };
});

// ─── Credentials management ───────────────────────────────────────────────────
// Stage password as pending — it gets saved only after successful SSH login is confirmed
ipcMain.handle('localterm:save-credential', (_, { user, host, port, password }) => {
  // Find the localShell sshState for this user@host and stage the credential
  let staged = false;
  for (const [tid, sh] of localShells.entries()) {
    if (sh.sshState && sh.sshState.user === user && sh.sshState.host === host) {
      sh.sshState._pendingCredential = { password };
      staged = true;
      logger.info('CREDS', 'Credential staged (pending login confirmation)', { user, host, port });
      break;
    }
  }
  // Also save immediately as a fallback (covers reconnect cases)
  if (!staged) {
    saveCredential(user, host, parseInt(port) || 22, password);
    logger.info('CREDS', 'Credential saved directly (no active sshState found)', { user, host, port });
  }
  return { ok: true };
});
ipcMain.handle('localterm:delete-credential', (_, { user, host, port }) => {
  deleteCredential(user, host, parseInt(port) || 22);
  return { ok: true };
});
ipcMain.handle('localterm:clear-all-credentials', () => {
  // Clear credentials.json entirely
  writeJSON(CREDENTIALS_FILE, {});
  logger.info('CREDS', 'All credentials cleared');
  return { ok: true };
});
ipcMain.handle('localterm:purge-credential-key', (_, { key }) => {
  // Delete a specific raw key from credentials.json (handles malformed entries)
  const creds = readCredentials();
  delete creds[key];
  writeJSON(CREDENTIALS_FILE, creds);
  logger.info('CREDS', 'Credential key purged', { key });
  return { ok: true };
});
ipcMain.handle('localterm:list-ssh-keys', () => {
  const keyDir = path.join(DATA_DIR, 'ssh_keys');
  try {
    if (!fs.existsSync(keyDir)) return [];
    return fs.readdirSync(keyDir)
      .filter(f => !f.endsWith('.pub'))
      .map(f => ({ name: f, path: path.join(keyDir, f) }));
  } catch(e) { return []; }
});
ipcMain.handle('localterm:delete-ssh-key', (_, { name }) => {
  const keyDir = path.join(DATA_DIR, 'ssh_keys');
  try {
    const keyPath = path.join(keyDir, name);
    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    if (fs.existsSync(keyPath + '.pub')) fs.unlinkSync(keyPath + '.pub');
    logger.info('CREDS', 'SSH key deleted', { name });
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('localterm:clear-all-ssh-keys', () => {
  const keyDir = path.join(DATA_DIR, 'ssh_keys');
  try {
    if (fs.existsSync(keyDir))
      fs.readdirSync(keyDir).forEach(f => { try { fs.unlinkSync(path.join(keyDir, f)); } catch(e) {} });
    logger.info('CREDS', 'All SSH keys cleared');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('localterm:list-credentials', () => {
  // Return credentials with passwords decrypted for renderer use
  const raw = readCredentials();
  const result = {};
  for (const [key, entry] of Object.entries(raw)) {
    result[key] = { ...entry, password: decryptPassword(entry), enc: undefined, value: undefined };
  }
  return result;
});
// Inject password into running PTY
ipcMain.handle('localterm:inject-password', (_, { tabId, password }) => {
  const sh = localShells.get(tabId);
  if (sh?.pty) {
    try { sh.pty.write(password + '\n'); return { ok: true }; } catch(e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Terminal not found' };
});

// ─── SSH Resize ────────────────────────────────────────────────────────────────
ipcMain.on('ssh:resize', (_, { tabId, cols, rows }) => {
  // Handle SSH stream resize
  const conn = connections.get(tabId);
  if (conn?.stream) {
    try { conn.stream.setWindow(rows, cols, 0, 0); } catch {}
  }
  // Also handle local PTY resize (same event used for both)
  const sh = localShells.get(tabId);
  if (sh?.pty) {
    try { sh.pty.resize(Math.max(cols, 10), Math.max(rows, 5)); } catch {}
  }
});

// ─── SSH Disconnect ────────────────────────────────────────────────────────────
ipcMain.handle('ssh:disconnect', (_, { tabId }) => {
  const conn = connections.get(tabId);
  if (conn) {
    logger.info('SSH', 'Disconnecting', { tabId });
    try { conn.stream?.close(); } catch {}
    try { conn.client?.end(); } catch {}
    connections.delete(tabId);
  }
  return true;
});

// ─── SSH Status ───────────────────────────────────────────────────────────────
ipcMain.handle('ssh:status', (_, { tabId }) => connections.has(tabId));

// ─── System Monitor: run command over SSH and return output ───────────────────
ipcMain.handle('ssh:exec', (_, { tabId, cmd }) => {
  const conn = connections.get(tabId);
  if (!conn) {
    logger.warn('SSH', 'exec called but not connected', { tabId, cmd: cmd.substring(0,60) });
    return { ok: false, error: 'Not connected' };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('SSH', 'exec timeout', { tabId, cmd: cmd.substring(0,60) });
      resolve({ ok: false, error: 'exec timeout' });
    }, 8000);
    conn.client.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        logger.error('SSH', 'exec failed', { tabId, cmd: cmd.substring(0,60), error: err.message });
        return resolve({ ok: false, error: err.message });
      }
      let out = '';
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { out += d.toString(); });
      stream.on('close', () => { clearTimeout(timer); resolve({ ok: true, output: out.trim() }); });
      stream.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    });
  });
});

// ─── Local Windows System Monitor ─────────────────────────────────────────────
const { exec: execChild } = require('child_process');
const util = require('util');
const execAsync = util.promisify(execChild);

ipcMain.handle('monitor:local', async () => {
  const isWin = process.platform === 'win32';
  const os2   = require('os');
  const path2 = require('path');
  const fs2   = require('fs');
  const { exec: execCb } = require('child_process');

  const run = (cmd, opts={}) => new Promise((res, rej) => {
    execCb(cmd, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
      if (err) rej(err); else res(stdout.trim());
    });
  });

  try {
    if (isWin) {
      // Write a PS1 script to temp dir — avoids ALL escaping issues
      const tmpScript = path2.join(DATA_DIR, 'roshi_monitor.ps1');
      const psScript = `
# CPU
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Write-Output "CPU:$cpu"

# Memory
$mem = Get-CimInstance Win32_OperatingSystem
$totalKB = $mem.TotalVisibleMemorySize
$freeKB  = $mem.FreePhysicalMemory
Write-Output "MEM:$totalKB $freeKB"

# Disk C:
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
Write-Output "DISK:$($disk.Size) $($disk.FreeSpace)"

# Uptime
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$up   = (Get-Date) - $boot
Write-Output "UPTIME:$($up.Days)d $($up.Hours)h $($up.Minutes)m"

# OS
$os = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Output "OS:$os"

# GPU
$gpu = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
Write-Output "GPU:$gpu"

# Top processes by working set (CPU time not reliable in PS, use WS)
$procs = Get-Process | Sort-Object CPU -Descending | Select-Object -First 8
foreach ($p in $procs) {
  $wsMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
  $cpuS = [math]::Round($p.CPU, 1)
  Write-Output "PROC:$($p.ProcessName)|$($p.Id)|$cpuS|$wsMB"
}

# Network adapters
$nets = Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled }
foreach ($n in $nets) {
  Write-Output "NET:$($n.Description)|0|0"
}

# Network bytes via counters (best effort)
try {
  $counters = Get-Counter '\\Network Interface(*)\\Bytes Received/sec','\\Network Interface(*)\\Bytes Sent/sec' -ErrorAction Stop
  foreach ($s in $counters.CounterSamples) {
    if ($s.Path -match 'Bytes Received') {
      $iface = ($s.Path -replace '.*\((.+)\).*','$1')
      Write-Output "NETBYTES:$iface|$([math]::Round($s.CookedValue))|0"
    }
  }
} catch {}
`;
      fs2.writeFileSync(tmpScript, psScript, 'utf8');
      if (!fs2.existsSync(tmpScript)) return { ok: false, error: 'Monitor script could not be written' };
      const raw = await run(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`);
      // Keep persistent — do NOT delete, avoids Defender race condition

      // Parse output lines
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      let cpu=0, memTotalKB=0, memFreeKB=0, diskTotal=0, diskFree=0;
      let uptime='', osName='', gpu='', procs=[], nets=[], netBytes={};

      for (const line of lines) {
        if (line.startsWith('CPU:'))     cpu = parseFloat(line.slice(4)) || 0;
        else if (line.startsWith('MEM:')) {
          const [t,f] = line.slice(4).split(' ').map(Number);
          memTotalKB=t; memFreeKB=f;
        }
        else if (line.startsWith('DISK:')) {
          const [t,f] = line.slice(5).split(' ').map(Number);
          diskTotal=t; diskFree=f;
        }
        else if (line.startsWith('UPTIME:')) uptime = line.slice(7);
        else if (line.startsWith('OS:'))     osName = line.slice(3);
        else if (line.startsWith('GPU:'))    gpu    = line.slice(4);
        else if (line.startsWith('PROC:')) {
          const [name,pid,cpuS,wsMB] = line.slice(5).split('|');
          procs.push({ name: (name||'').substring(0,28), pid: pid?.trim(), cpu: parseFloat(cpuS)||0, mem: parseFloat(wsMB)||0 });
        }
        else if (line.startsWith('NETBYTES:')) {
          const [iface,rx] = line.slice(9).split('|');
          if (!netBytes[iface]) netBytes[iface] = { rx:0, tx:0 };
          netBytes[iface].rx += parseInt(rx)||0;
        }
        else if (line.startsWith('NET:')) {
          const [desc] = line.slice(4).split('|');
          if (desc && !nets.find(n=>n.name===desc))
            nets.push({ name: desc.substring(0,40), rx: netBytes[desc]?.rx||0, tx: 0 });
        }
      }

      // If NETBYTES filled in, use those
      if (Object.keys(netBytes).length > 0) {
        nets = Object.entries(netBytes).map(([name,v]) => ({ name: name.substring(0,40), rx: v.rx, tx: v.tx }));
      }

      const memTotalMB = memTotalKB / 1024;
      const memFreeMB  = memFreeKB  / 1024;
      const memUsedMB  = memTotalMB - memFreeMB;
      const memPct     = memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : 0;
      const diskUsed   = diskTotal  - diskFree;
      const diskPct    = diskTotal  ? Math.round((diskUsed / diskTotal) * 100) : 0;
      const toGB       = b => b ? (b / 1e9).toFixed(1) : '0';

      return {
        ok: true, platform: 'windows',
        cpu:  { pct: cpu },
        mem:  { usedMB: memUsedMB, totalMB: memTotalMB, pct: memPct, freeMB: memFreeMB },
        disk: { pct: diskPct, usedGB: toGB(diskUsed), freeGB: toGB(diskFree), totalGB: toGB(diskTotal) },
        uptime, os: osName, gpu, procs, nets,
      };

    } else {
      // ── Linux / macOS local ──
      const [cpuOut,memOut,diskOut,uptimeOut,procOut,netOut,osOut] = await Promise.all([
        run(`awk '/^cpu / {idle=$5;tot=0;for(i=2;i<=NF;i++)tot+=$i;printf "%.1f",(1-idle/tot)*100}' /proc/stat`).catch(()=>'0'),
        run(`free -m | awk '/^Mem:/{printf "%d %d %d",$2,$3,$4}'`).catch(()=>'0 0 0'),
        run(`df -h / | awk 'NR==2{printf "%s %s %s %s",$2,$3,$4,$5}'`).catch(()=>'0 0 0 0%'),
        run(`uptime`).catch(()=>'—'),
        run(`ps aux --sort=-%cpu | awk 'NR>1&&NR<=9{printf "%s|%s|%s|%s|%s\\n",$11,$2,$3,$4,$1}'`).catch(()=>''),
        run(`awk 'NR>2&&$1!="lo:"{gsub(":","");printf "%s|%s|%s\\n",$1,$2,$10}' /proc/net/dev`).catch(()=>''),
        run(`grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'"' -f2 || uname -sr`).catch(()=>'Linux'),
      ]);
      const [mT,mU] = memOut.split(' ').map(Number);
      const dP = diskOut.split(' ');
      return {
        ok: true, platform: 'linux',
        cpu:  { pct: parseFloat(cpuOut)||0 },
        mem:  { usedMB:mU, totalMB:mT, pct:mT?Math.round((mU/mT)*100):0, freeMB:mT-mU },
        disk: { pct:parseInt(dP[3])||0, usedGB:dP[1], freeGB:dP[2], totalGB:dP[0] },
        uptime: (() => { const m = uptimeOut.match(/up\s+(.+?),\s+\d+\s+user/); return m ? m[1].trim() : uptimeOut.replace(/.*up\s+/,'').split(',').slice(0,2).join(',').trim() || '—'; })(),
        os: osOut, gpu:'N/A',
        procs: procOut.split('\n').filter(Boolean).map(l=>{
          const [n,p,c,m]=l.split('|');
          return {name:(n||'').split('/').pop().substring(0,28),pid:p?.trim(),cpu:parseFloat(c)||0,mem:parseFloat(m)||0};
        }),
        nets: netOut.split('\n').filter(Boolean).map(l=>{
          const [n,r,t]=l.split('|'); return {name:n?.trim(),rx:parseInt(r)||0,tx:parseInt(t)||0};
        }),
      };
    }
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ─── Local Terminal using node-pty (real PTY — same as VS Code) ──────────────
const localShells = new Map();

function getPtyModule() {
  try { return require('node-pty'); } catch (e) {
    console.error('node-pty not found. Run: npm install node-pty');
    return null;
  }
}

function resolveShell(shellPref) {
  const isWin = process.platform === 'win32';
  if (!isWin) return { bin: process.env.SHELL || '/bin/bash', args: [], type: 'bash' };

  if (shellPref === 'cmd') return { bin: 'cmd.exe', args: [], type: 'cmd' };

  if (shellPref === 'gitbash' || shellPref === 'bash') {
    // Check common Git Bash paths + dynamic user path
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\' + (process.env.USERNAME || 'User');
    const paths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      path.join(userProfile, 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
      'D:\\Program Files\\Git\\bin\\bash.exe',
    ];
    // Also try where.exe to find git dynamically
    try {
      const { execSync } = require('child_process');
      const gitPath = execSync('where git', { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0];
      if (gitPath) {
        const gitBash = path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe');
        if (!paths.includes(gitBash)) paths.unshift(gitBash);
      }
    } catch(e) {}
    for (const p of paths) {
      try {
        const nativePath = p.replace(/\\\\/g, '\\');
        if (require('fs').existsSync(nativePath)) {
          return { bin: nativePath, args: ['--login', '-i'], type: 'gitbash',
            gitRoot: path.dirname(path.dirname(nativePath)) };
        }
      } catch(e) {}
    }
    // fallback to powershell if git bash not found
  }

  if (shellPref === 'pwsh') {
    for (const p of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\6\\pwsh.exe']) {
      try { if (fs.existsSync(p)) return { bin: p, args: ['-NoLogo'], type: 'pwsh' }; } catch {}
    }
  }

  return { bin: 'powershell.exe', args: ['-NoLogo'], type: 'powershell' };
}

ipcMain.handle('localterm:start', (_, { tabId, shell: shellPref, cols, rows }) => {
  // Kill existing
  if (localShells.has(tabId)) {
    try { localShells.get(tabId).pty.kill(); } catch {}
    localShells.delete(tabId);
  }

  const ptyModule = getPtyModule();
  if (!ptyModule) {
    logger.error('LOCALTERM', 'node-pty not installed', { tabId });
    return { ok: false, error: 'node-pty not installed. Run: npm install node-pty' };
  }

  const resolved = resolveShell(shellPref || 'gitbash');
  logger.info('LOCALTERM', 'Starting local terminal', { tabId, shell: resolved.type, bin: resolved.bin });
  let cwd = os.homedir();
  try { if (!fs.existsSync(cwd)) cwd = 'C:\\'; } catch { cwd = 'C:\\'; }

  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

  // Always set COLUMNS/LINES so shell knows exact terminal size
  env.COLUMNS = String(cols || 80);
  env.LINES   = String(rows || 24);

  // Git Bash specific env
if (resolved.type === 'gitbash') {
  env.TERM        = 'xterm-256color';
  env.MSYSTEM     = 'MINGW64';
  env.INPUTRC     = '/dev/null';
  env.BASH_ENV    = '';
  if (resolved.gitRoot) {
    const gitBin     = path.join(resolved.gitRoot, 'bin');
    const gitUsr     = path.join(resolved.gitRoot, 'usr', 'bin');
    const gitMingw   = path.join(resolved.gitRoot, 'mingw64', 'bin');
    const gitMingwUsr = path.join(resolved.gitRoot, 'mingw64', 'usr', 'bin');
    env.PATH = [gitBin, gitUsr, gitMingw, gitMingwUsr, env.PATH || ''].join(';');
  }
  // Git Bash uses ~/.ssh/known_hosts natively — RoshiLABX watches that file
  // and syncs new host keys into known_hosts.json automatically.

  }

  let ptyProc;
  try {
    ptyProc = ptyModule.spawn(resolved.bin, resolved.args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
      useConpty: true,
      useConptyDll: false,
    });
  } catch (e) {
    // ConPTY failed, try winpty fallback
    try {
      ptyProc = ptyModule.spawn(resolved.bin, resolved.args, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env,
        useConpty: false,
      });
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }

  // sshState is stored on the shell entry so IPC handlers can access _pendingCredential
  const sshState = { buf: '', host: '', user: '', port: 22, awaitingPrompt: false, handled: false, loggedIn: false, watchForPrompt: false, _pendingCredential: null };
  localShells.set(tabId, { pty: ptyProc, type: resolved.type, sshState });

  // Force resize multiple times to sync terminal dimensions
  setTimeout(() => { try { ptyProc.resize(cols || 80, rows || 24); } catch(e) {} }, 100);
  setTimeout(() => { try { ptyProc.resize(cols || 80, rows || 24); } catch(e) {} }, 300);
  setTimeout(() => { try { ptyProc.resize(cols || 80, rows || 24); } catch(e) {} }, 800);
  setTimeout(() => { try { ptyProc.resize(cols || 80, rows || 24); } catch(e) {} }, 1500);

  // ── SSH credential detection in local terminal ──────────────────────────────

  ptyProc.onData((data) => {
    win?.webContents.send('localterm:data', { tabId, data });

    // Accumulate output for pattern matching (keep last 2KB)
    sshState.buf = (sshState.buf + data).slice(-2048);

    // Detect ssh command — look for "ssh [opts] user@host" or "ssh -p port user@host"
    if (!sshState.awaitingPrompt) {
      const cmdMatch = sshState.buf.match(/ssh(?:\s+-p\s*(\d+))?\s+([a-zA-Z0-9_.-]+)@([\d.a-zA-Z-]+)/);
      if (cmdMatch) {
        sshState.port = parseInt(cmdMatch[1]) || 22;
        sshState.user = cmdMatch[2];
        sshState.host = cmdMatch[3];
        sshState.awaitingPrompt = true;
        sshState.handled = false;
        sshState.loggedIn = false;
      }
    }

    // Detect password prompt
    if (sshState.awaitingPrompt && !sshState.handled && /password:\s*$/i.test(sshState.buf)) {
      sshState.handled = true;
      const { host, user, port } = sshState;

      const savedPwd = getDecryptedCredential(user, host, port);

      if (savedPwd) {
        // Saved credential found — inject silently (MobaXterm-style)
        logger.info('CREDS', 'Auto-injecting saved credential', { user, host, port });
        setTimeout(() => {
          try { ptyProc.write(savedPwd + '\n'); } catch(e) {}
        }, 100);
      } else {
        // No saved credential — show the password prompt modal
        // password will be captured via localterm:save-credential IPC and saved on success
        win?.webContents.send('localterm:ssh-save-pwd-prompt', { tabId, host, user, port });
      }

      sshState.watchForPrompt = true;
      sshState.awaitingPrompt = false;
      sshState.handled = false;
      sshState.buf = '';
    }

    // Reset pending credential if login failed (Permission denied)
    if (sshState._pendingCredential && /permission denied|authentication failed/i.test(sshState.buf)) {
      logger.info('CREDS', 'Login failed — discarding staged credential', { user: sshState.user, host: sshState.host });
      sshState._pendingCredential = null;
      sshState.watchForPrompt = false;
      sshState.loggedIn = false;
      sshState.buf = '';
    }

    // Detect successful login — auto-save pending credential silently, no popup
    // Guard: must NOT be a failed auth — "Permission denied" means wrong password
    const _loginFailed = /permission denied|authentication failed|try again/i.test(sshState.buf);
    if (sshState.host && !sshState.loggedIn && sshState.watchForPrompt &&
        /(?:[$#>])\s*$/.test(sshState.buf) && sshState.buf.length > 10 && !_loginFailed) {
      sshState.loggedIn = true;
      sshState.watchForPrompt = false;
      const { host, user, port } = sshState;

      // If a pending credential was staged (user typed password in modal), save it now
      if (sshState._pendingCredential) {
        const { password } = sshState._pendingCredential;
        if (password) {
          // Save into credentials.json (for future Git Bash auto-fill)
          saveCredential(user, host, port, password);
          logger.info('CREDS', 'Auto-saved credential on successful login', { user, host, port });

          // Also mirror into any matching saved session so session login stays in sync
          const sessions = readJSON(SESSIONS_FILE, []);
          let sessionUpdated = false;
          for (const s of sessions) {
            if (s.host === host && s.username === user && s.authType === 'password') {
              const enc = encryptPassword(password);
              s.password = enc.value;
              s._pwdEncrypted = enc.enc;
              sessionUpdated = true;
            }
          }
          if (sessionUpdated) {
            writeJSON(SESSIONS_FILE, sessions);
            logger.info('CREDS', 'Mirrored Git Bash credential back into matching sessions', { user, host, port });
          }

          win?.webContents.send('ssh:data', {
            tabId,
            data: `
[32m🔐 Password saved securely for ${user}@${host}[0m
`
          });
          // Auto-erase message after 2s using ANSI escape: move up 2 lines + clear each
          setTimeout(() => {
            try {
              win?.webContents.send('ssh:data', { tabId, data: '\x1b[1A\x1b[2K\x1b[1A\x1b[2K' });
            } catch(e) {}
          }, 2000);
        }
        sshState._pendingCredential = null;
      }
      // No session-save popup — user manages sessions manually via sidebar
    }
  });

  // Fix terminal size silently using resize only — no shell commands
  if (resolved.type === 'gitbash' || resolved.type === 'bash') {
    const fixSize = () => {
      try { ptyProc.resize(cols || 80, rows || 24); } catch(e) {}
    };
    setTimeout(fixSize, 600);
    setTimeout(fixSize, 1500);
  }

  ptyProc.onExit(({ exitCode }) => {
    logger.info('LOCALTERM', 'Terminal exited', { tabId, exitCode });
    localShells.delete(tabId);
    win?.webContents.send('localterm:closed', { tabId, code: exitCode });
  });

  return { ok: true, shell: resolved.bin, type: resolved.type };
});

ipcMain.on('localterm:input', (_, { tabId, data }) => {
  const sh = localShells.get(tabId);
  if (sh?.pty) {
    try { sh.pty.write(data); } catch (e) { console.error('localterm:input error:', e); }
  }
});

// List available shells
ipcMain.handle('localterm:shells', () => {
  const isWin = process.platform === 'win32';
  const available = [];
  if (isWin) {
    for (const p of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\6\\pwsh.exe']) {
      try { if (fs.existsSync(p)) { available.push({ id:'pwsh', label:'PowerShell Core', path: p }); break; } } catch {}
    }
    // Git Bash — check multiple paths
    const userProfile2 = process.env.USERPROFILE || 'C:\\Users\\User';
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      path.join(userProfile2, 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
      'D:\\Program Files\\Git\\bin\\bash.exe',
    ];
    // Try where.exe
    try {
      const { execSync } = require('child_process');
      const gitPath = execSync('where git', { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0];
      if (gitPath) {
        const gitBash = path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe');
        if (!gitBashPaths.includes(gitBash)) gitBashPaths.unshift(gitBash);
      }
    } catch(e) {}
    for (const p of gitBashPaths) {
      try { if (fs.existsSync(p)) { available.push({ id:'gitbash', label:'Git Bash', path: p }); break; } } catch {}
    }
    available.push({ id:'powershell', label:'PowerShell 5', path: 'powershell.exe' });
  } else {
    available.push({ id:'bash', label:'Bash', path: process.env.SHELL || '/bin/bash' });
  }
  return available;
});

ipcMain.handle('localterm:stop', (_, { tabId }) => {
  const sh = localShells.get(tabId);
  if (sh) { try { sh.pty.kill(); } catch {} localShells.delete(tabId); }
  return true;
});

// Also handle local pty resize from renderer
// ─── SSH Key Setup (generate key + ssh-copy-id) ───────────────────────────────
ipcMain.handle('localterm:setup-key-auth', async (_, { tabId, host, user, password, port }) => {
  const crypto  = require('crypto');
  const { execSync, spawn } = require('child_process');

  // Key storage dir
  const keyDir  = path.join(DATA_DIR, 'ssh_keys');
  const keyName = `roshilabx_${user}_${host.replace(/\./g, '_')}`;
  const keyPath = path.join(keyDir, keyName);
  const pubPath = keyPath + '.pub';

  try {
    fs.mkdirSync(keyDir, { recursive: true });
  } catch(e) {}

  // Generate ED25519 key pair if not already there
  if (!fs.existsSync(keyPath)) {
    try {
      // Use ssh-keygen from Git Bash
      const resolved = resolveShell('gitbash');
      const gitUsr = resolved.gitRoot
        ? require('path').join(resolved.gitRoot, 'usr', 'bin')
        : 'C:\\Program Files\\Git\\usr\\bin';
      const sshKeygen = path.join(gitUsr, 'ssh-keygen.exe');

      execSync(
        `"${sshKeygen}" -t ed25519 -C "roshilabx@${host}" -f "${keyPath}" -N ""`,
        { encoding: 'utf8', timeout: 10000 }
      );
    } catch(e) {
      return { ok: false, error: 'ssh-keygen failed: ' + e.message };
    }
  }

  // Read the public key
  let pubKey;
  try {
    pubKey = fs.readFileSync(pubPath, 'utf8').trim();
  } catch(e) {
    return { ok: false, error: 'Could not read public key: ' + e.message };
  }

  // Use ssh2 to copy the public key to the server (authorized_keys)
  let Client;
  try { Client = require('ssh2').Client; } catch(e) {
    return { ok: false, error: 'ssh2 not installed' };
  }

  return new Promise((resolve) => {
    const client = new Client();
    client.on('ready', () => {
      // Ensure ~/.ssh exists and append key to authorized_keys
      const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo '__ROSHI_KEY_OK__'`;
      client.exec(cmd, (err, stream) => {
        if (err) { client.end(); return resolve({ ok: false, error: err.message }); }
        let out = '';
        stream.on('data', d => { out += d.toString(); });
        stream.on('close', () => {
          client.end();
          if (out.includes('__ROSHI_KEY_OK__')) {
            // Mark this host+user as key-authenticated in known_hosts store
            const hosts = readKnownHosts();
            const key = `${host}:${parseInt(port)||22}`;
            if (!hosts[key]) hosts[key] = {};
            hosts[key].keyAuth = true;
            hosts[key].keyUser = user;
            hosts[key].keyFile = keyPath;
            writeKnownHosts(hosts);

            // Also update any matching session to use key auth
            const sess = readJSON(SESSIONS_FILE, []);
            let updated = false;
            for (const s of sess) {
              if (s.host === host && s.username === user) {
                s.authType = 'key';
                s.privateKey = fs.readFileSync(keyPath, 'utf8');
                s.keyPath = keyPath;
                updated = true;
              }
            }
            if (updated) writeJSON(SESSIONS_FILE, sess);

            resolve({ ok: true, keyPath, pubKey });
          } else {
            resolve({ ok: false, error: 'Key copy failed — check server permissions' });
          }
        });
      });
    });
    client.on('error', err => resolve({ ok: false, error: err.message }));
    client.connect({
      host, port: parseInt(port) || 22, username: user, password,
      readyTimeout: 12000, tryKeyboard: true,
    });
    client.on('keyboard-interactive', (n, i, l, p, finish) => finish([password]));
  });
});

// ─── Remove Key Auth — deletes key from server + local key file ───────────────
ipcMain.handle('localterm:remove-key-auth', async (_, { sessId, host, port, username, password, keyPath }) => {
  let Client;
  try { Client = require('ssh2').Client; } catch(e) { return { ok: false, error: 'ssh2 not installed' }; }

  // Step 1: Connect with password and remove key from authorized_keys
  const removeResult = await new Promise((resolve) => {
    const client = new Client();
    client.on('ready', () => {
      // Remove all lines containing 'roshilabx' from authorized_keys
      const cmd = `sed -i '/roshilabx/d' ~/.ssh/authorized_keys && echo '__ROSHI_KEY_REMOVED__'`;
      client.exec(cmd, (err, stream) => {
        if (err) { client.end(); return resolve({ ok: false, error: err.message }); }
        let out = '';
        stream.on('data', d => { out += d.toString(); });
        stream.on('close', () => {
          client.end();
          resolve({ ok: out.includes('__ROSHI_KEY_REMOVED__'), output: out });
        });
      });
    });
    client.on('error', err => resolve({ ok: false, error: err.message }));
    client.connect({
      host, port: parseInt(port) || 22, username, password,
      readyTimeout: 12000, tryKeyboard: true,
    });
    client.on('keyboard-interactive', (n, i, l, p, finish) => finish([password]));
  });

  if (!removeResult.ok) {
    return { ok: false, error: removeResult.error || 'Could not connect to remove key — check password' };
  }

  // Step 2: Delete local key file
  if (keyPath) {
    try {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(keyPath + '.pub')) fs.unlinkSync(keyPath + '.pub');
      logger.info('CREDS', 'Local key files deleted', { keyPath });
    } catch(e) {
      logger.warn('CREDS', 'Could not delete local key file (non-fatal)', { keyPath, error: e.message });
    }
  }

  // Step 3: Update known_hosts store to clear keyAuth flag for this host
  const hosts = readKnownHosts();
  const key = `${host}:${parseInt(port) || 22}`;
  if (hosts[key]) {
    delete hosts[key].keyAuth;
    delete hosts[key].keyUser;
    delete hosts[key].keyFile;
    writeKnownHosts(hosts);
  }

  logger.info('CREDS', 'Key auth removed successfully', { host, username });
  return { ok: true };
});

ipcMain.on('localterm:resize', (_, { tabId, cols, rows }) => {
  const sh = localShells.get(tabId);
  if (sh?.pty) { try { sh.pty.resize(cols, rows); } catch {} }
});

// Clean up all PTYs on quit
app.on('before-quit', () => {
  localShells.forEach(({ pty }) => { try { pty.kill(); } catch {} });
});
