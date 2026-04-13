'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roshi', {
  minimize:     () => ipcRenderer.send('win:min'),
  maximize:     () => ipcRenderer.send('win:max'),
  close:        () => ipcRenderer.send('win:close'),
  loadSessions: ()  => ipcRenderer.invoke('sessions:load'),
  saveSessions: (d) => ipcRenderer.invoke('sessions:save', d),
  loadSettings: ()  => ipcRenderer.invoke('settings:load'),
  saveSettings: (d) => ipcRenderer.invoke('settings:save', d),
  connect:      (cfg)         => ipcRenderer.invoke('ssh:connect', cfg),
  disconnect:   (tabId)       => ipcRenderer.invoke('ssh:disconnect', { tabId }),
  isConnected:  (tabId)       => ipcRenderer.invoke('ssh:status', { tabId }),
  sendInput:    (tabId, data) => ipcRenderer.send('ssh:input', { tabId, data }),
  resizeTerm:   (tabId, c, r) => ipcRenderer.send('ssh:resize', { tabId, cols: c, rows: r }),
  exec:         (tabId, cmd)  => ipcRenderer.invoke('ssh:exec', { tabId, cmd }),
  localStart:   (cfg)         => ipcRenderer.invoke('localterm:start', cfg),
  localInput:   (tabId, data) => ipcRenderer.send('localterm:input', { tabId, data }),
  localStop:    (tabId)       => ipcRenderer.invoke('localterm:stop', { tabId }),
  localShells:  ()            => ipcRenderer.invoke('localterm:shells'),
  monitorLocal: ()            => ipcRenderer.invoke('monitor:local'),
  // Native clipboard via Electron (works without browser permissions)
  clipboardRead:  ()     => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  onLocalData:  (cb) => {
    ipcRenderer.removeAllListeners('localterm:data');
    ipcRenderer.on('localterm:data', (_, p) => cb(p));
  },
  onLocalClose: (cb) => {
    ipcRenderer.removeAllListeners('localterm:closed');
    ipcRenderer.on('localterm:closed', (_, p) => cb(p));
  },
  onData:       (cb) => {
    ipcRenderer.removeAllListeners('ssh:data');
    ipcRenderer.on('ssh:data', (_, p) => cb(p));
  },
  onClosed:     (cb) => {
    ipcRenderer.removeAllListeners('ssh:closed');
    ipcRenderer.on('ssh:closed', (_, p) => cb(p));
  },
  openKeyFile:  ()   => ipcRenderer.invoke('dialog:key'),

  // ── SSH Password Save (local terminal) ────────────────────────────────────
  onSshSavePwdPrompt:    (cb) => ipcRenderer.on('localterm:ssh-save-pwd-prompt', (_, d) => cb(d)),
  onSuggestSaveSession:  (cb) => ipcRenderer.on('localterm:suggest-save-session', (_, d) => cb(d)),
  saveCredential:     (cfg) => ipcRenderer.invoke('localterm:save-credential', cfg),
  injectPassword:     (tabId, password) => ipcRenderer.invoke('localterm:inject-password', { tabId, password }),
  listCredentials:    () => ipcRenderer.invoke('localterm:list-credentials'),
  deleteCredential:   (cfg) => ipcRenderer.invoke('localterm:delete-credential', cfg),
  clearAllCredentials:() => ipcRenderer.invoke('localterm:clear-all-credentials'),
  purgeCredentialKey: (key) => ipcRenderer.invoke('localterm:purge-credential-key', { key }),
  listSshKeys:        () => ipcRenderer.invoke('localterm:list-ssh-keys'),
  deleteSshKey:       (cfg) => ipcRenderer.invoke('localterm:delete-ssh-key', cfg),
  clearAllSshKeys:    () => ipcRenderer.invoke('localterm:clear-all-ssh-keys'),
  removeKeyAuth:      (cfg) => ipcRenderer.invoke('localterm:remove-key-auth', cfg),
  onHostKeyPrompt:   (cb) => ipcRenderer.on('ssh:hostkey-prompt',   (_, d) => cb(d)),
  onHostKeyMismatch: (cb) => ipcRenderer.on('ssh:hostkey-mismatch', (_, d) => cb(d)),
  respondHostKey:    (tabId, accepted) => ipcRenderer.send(`ssh:hostkey-response:${tabId}`, { accepted }),

  // ── Known Hosts Management ─────────────────────────────────────────────────
  listKnownHosts:  ()           => ipcRenderer.invoke('ssh:known-hosts:list'),
  removeKnownHost: (host, port) => ipcRenderer.invoke('ssh:known-hosts:remove', { host, port }),

  // ── Logging ────────────────────────────────────────────────────────────────
  logWrite: (level, category, message, data) => ipcRenderer.invoke('log:write', { level, category, message, data }),
  logOpen:  () => ipcRenderer.invoke('log:open'),
  logPath:  () => ipcRenderer.invoke('log:path'),
});
