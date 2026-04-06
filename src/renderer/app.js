'use strict';
/* ══════════════════════════════════════════
   RoshiLABX — Renderer (app.js)
   Features: SSH, System Monitor, Auto-hide
   Sidebar, Mouse Wheel Font Size
══════════════════════════════════════════ */

const $ = id => document.getElementById(id);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── State ──────────────────────────────────────────────────────────────────
let sessions=[], tabs=[], activeTabId=null;
let settings={ theme:'default', fontSize:13, cursorStyle:'block', opacity:100,
               fontFamily:"Consolas,'Courier New',monospace", sidebarHidden:false,
               fontWeight:400, lineHeight:1.2, letterSpacing:0, cursorBlink:true, scrollback:10000,
               termBg:'', termFg:'', termCursor:'', termSel:'',
               sbTheme:'dark', sbAccent:'#00e5ff', sbFontFam:'inherit', sbFontSize:13,
               sbWidth:220, sbPad:'compact',
               sbBg:'', sbText:'', sbHover:'', sbBorder:'',
               wallpaper:'none', wpOpacity:20, wpTarget:'terminal', customWpImage:'',
               winOpacity:100, termTransparent:false };
let editSessId=null, keyContent=null, selColor='#39ff6e', selAuth='password';
const LOCAL_PREFIX = 'local-'; // prefix for local terminal tab IDs
let k8sOpen=false, cpOpen=false, toastTmr, fontToastTmr;

// Monitor state
let monInterval=null, monRunning=false, monTabId=null;

// Sidebar state
let sbHidden=false, sbPeeking=false, sbPeekTimer=null;

// ── BOOT ───────────────────────────────────────────────────────────────────
async function boot() {
  if (typeof Terminal === 'undefined') {
    document.body.innerHTML = '<div style="color:#ff4757;font-family:monospace;padding:40px;font-size:14px;"><h2>⚠ xterm.js not found</h2><br>Run: <b>npm install</b> then restart.</div>';
    return;
  }
  try {
    [settings, sessions] = await Promise.all([window.roshi.loadSettings(), window.roshi.loadSessions()]);
  } catch(e) { console.error(e); }
  settings = Object.assign({ theme:'default', fontSize:13, cursorStyle:'block', opacity:100,
    fontFamily:"Consolas,'Courier New',monospace", sidebarHidden:false,
    fontWeight:400, lineHeight:1.2, letterSpacing:0, cursorBlink:true, scrollback:10000,
    termBg:'', termFg:'', termCursor:'', termSel:'',
    sbTheme:'dark', sbAccent:'#00e5ff', sbFontFam:'inherit', sbFontSize:13,
    sbWidth:220, sbPad:'compact', sbBg:'', sbText:'', sbHover:'', sbBorder:'',
    wallpaper:'none', wpOpacity:20, wpTarget:'terminal', customWpImage:'',
    winOpacity:100, termTransparent:false }, settings);

  applyTheme(settings.theme, false);
  $('fval').textContent = settings.fontSize + 'px';
  $('opSlider').value = settings.opacity;
  $('opVal').textContent = settings.opacity + '%';
  if (settings.fontFamily) $('fontFam').value = settings.fontFamily;
  if (settings.sidebarHidden) setSidebar(true, false);
  applySidebarTheme(settings.sbTheme, false);
  applyAccent(settings.sbAccent, false);
  restoreCpanelUI();
  if (settings.customWpImage) applyWallpaper('image', false);
  else if (settings.wallpaper && settings.wallpaper !== 'none') applyWallpaper(settings.wallpaper, false);
  // Apply saved window opacity
  if (settings.winOpacity && settings.winOpacity < 100) {
    window.roshi.setWinOpacity(settings.winOpacity / 100);
  }
  if ($('winOpSlider')) { $('winOpSlider').value = settings.winOpacity || 100; $('winOpVal').textContent = (settings.winOpacity || 100) + '%'; }
  // Apply saved terminal transparency state
  setTimeout(() => applyTermTransparency(settings.termTransparent || false, false), 0);

  renderSessList();
  showView('home');
  bindAll();
  detectShells(); // auto-populate shell dropdowns

  window.roshi.onData(({ tabId, data }) => { getTab(tabId)?.term?.write(data); });
  window.roshi.onLocalData(({ tabId, data }) => { getTab(tabId)?.term?.write(data); });
  window.roshi.onLocalClose(({ tabId, code }) => {
    const t = getTab(tabId);
    if (!t) return;
    t.connected = false; t.isLocal = false;
    // Instant close — go home immediately
    t.el?.remove();
    tabs = tabs.filter(x => x.id !== tabId);
    activeTabId = tabs.length ? tabs[tabs.length-1].id : null;
    renderTabs();
    if (!tabs.length) {
      showView('home');
      setSidebar(false, true);
    } else {
      switchTab(activeTabId);
    }
  });
  window.roshi.onClosed(({ tabId }) => {
    const t = getTab(tabId);
    if (!t) return;
    t.connected = false;
    setDot(t.sessId,'off');
    if (monTabId === tabId) stopMonitor();
    // Close tab instantly and go home
    t.el?.remove();
    tabs = tabs.filter(x => x.id !== tabId);
    activeTabId = tabs.length ? tabs[tabs.length-1].id : null;
    renderTabs();
    if (!tabs.length) { showView('home'); setSidebar(false, true); }
    else switchTab(activeTabId);
  });

  // ── Host key: unknown host — ask to trust ────────────────────────────────
  window.roshi.onHostKeyPrompt(({ tabId, host, port, fingerprint, keyType }) => {
    showHostKeyDialog({
      tabId, host, port, fingerprint, keyType,
      title: '🔐 Unknown Host',
      subtitle: `First connection to <b>${host}:${port}</b>.<br>Verify the fingerprint before trusting.`,
      acceptLabel: 'Trust & Connect',
      isNew: true,
    });
  });

  // ── Host key: mismatch — key changed (e.g. after VM rebuild) ────────────
  window.roshi.onHostKeyMismatch(({ tabId, host, port, fingerprint, savedFingerprint, keyType }) => {
    showHostKeyDialog({
      tabId, host, port, fingerprint, keyType,
      savedFingerprint,
      title: '⚠ Host Key Changed',
      subtitle: `The key for <b>${host}:${port}</b> has changed since last connection.<br>
                 This is expected after a VM rebuild or snapshot restore.<br>
                 <span style="color:var(--txt3);font-size:11px">Old: <code>${savedFingerprint}</code></span>`,
      acceptLabel: '✅ Trust New Key & Connect',
      isNew: false,
    });
  });
}

// ── Host Key Trust Dialog ────────────────────────────────────────────────────
function showHostKeyDialog({ tabId, host, port, fingerprint, keyType, savedFingerprint, title, subtitle, acceptLabel, isNew }) {
  const existing = document.getElementById('hostKeyOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'hostKeyOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:#00000099;z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

  const borderColor = isNew ? 'var(--cyan)' : 'var(--yel, #ffd700)';
  const titleColor  = isNew ? 'var(--cyan)' : 'var(--yel, #ffd700)';

  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid ${borderColor};border-radius:10px;width:500px;overflow:hidden;box-shadow:0 0 0 1px var(--bd),0 20px 60px #00000090;">
      <div style="padding:14px 18px;border-bottom:2px solid ${borderColor};background:var(--bg2);display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">${isNew ? '🔐' : '⚠'}</span>
        <span style="font-size:13px;font-weight:800;color:${titleColor}">${title}</span>
      </div>
      <div style="padding:18px">
        <div style="font-size:12px;color:var(--txt2);margin-bottom:14px;line-height:1.7">${subtitle}</div>
        <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:10px 12px;font-family:monospace;font-size:11px;">
          <div style="color:var(--txt3);margin-bottom:4px">New fingerprint (${keyType}):</div>
          <span style="color:var(--cyan)">${fingerprint}</span>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--bd);background:var(--bg2)">
        <button id="hkCancel" style="background:transparent;border:1px solid var(--bd2);color:var(--txt2);padding:8px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">Cancel</button>
        <button id="hkAccept" style="background:${borderColor};border:1px solid ${borderColor};color:#000;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">${acceptLabel}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  function dismiss() { overlay.remove(); }

  overlay.querySelector('#hkCancel').onclick = () => {
    if (window.roshi.logWrite) window.roshi.logWrite('INFO', 'HOSTKEY', 'User cancelled host key dialog', { host, port });
    window.roshi.respondHostKey(tabId, false);
    dismiss();
  };

  overlay.querySelector('#hkAccept').onclick = async () => {
    if (!isNew) await window.roshi.removeKnownHost(host, port);
    if (window.roshi.logWrite) window.roshi.logWrite('INFO', 'HOSTKEY', `User accepted host key via dialog`, { host, port, isNew });
    window.roshi.respondHostKey(tabId, true);
    dismiss();
  };

  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      window.roshi.respondHostKey(tabId, false);
      dismiss();
    }
  });
}
function bindAll() {
  $('btnMin').onclick   = ()=>window.roshi.minimize();
  $('btnMax').onclick   = ()=>window.roshi.maximize();
  $('btnClose').onclick = ()=>window.roshi.close();
  if($('btnNewSess')) $('btnNewSess').onclick = ()=>openModal(null);
  if($('btnK8s')) $('btnK8s').onclick = toggleK8s;
  $('btnColors').onclick= toggleCP;
  if($('btnOpenLog')) $('btnOpenLog').onclick = ()=>window.roshi.logOpen();

  // Renderer-side error logging — catch unhandled errors and log them
  window.onerror = (msg, src, line, col, err) => {
    window.roshi.logWrite('ERROR', 'RENDERER', `Unhandled error: ${msg}`, { src, line, col, stack: err?.stack });
  };
  window.onunhandledrejection = (e) => {
    window.roshi.logWrite('ERROR', 'RENDERER', `Unhandled promise rejection: ${e.reason}`, {});
  };
  $('sbAdd').onclick    = ()=>openModal(null);
  $('tabAdd').onclick = ()=>openLocalTerminal('gitbash');
  $('homeAdd').onclick  = ()=>openModal(null);
  $('homeLocal').onclick = ()=>openLocalTerminal('gitbash');
  if($('homeGitBash')) $('homeGitBash').onclick = ()=>openLocalTerminal('gitbash');
  if($('btnLocalTerm')) $('btnLocalTerm').onclick = ()=>openLocalTerminal('gitbash');
  if($('hcLocal')) $('hcLocal').onclick = ()=>openLocalTerminal('gitbash');
  if($('hcSSH')) $('hcSSH').onclick = ()=>openModal(null);
  runBootSequence();
  $('btnDisconn').onclick = disconnectActive;
  $('btnReconn').onclick  = reconnectActive;
  $('btnDup').onclick     = duplicateActive;

  // Sidebar toggle button + keyboard shortcut
  $('sbToggle').onclick = ()=>setSidebar(!sbHidden, true);
  if($('sbStripToggle')) $('sbStripToggle').onclick = ()=>setSidebar(!sbHidden, true);
  // Strip nav buttons
  $$('.sb-strip-btn[data-nav]').forEach(el => el.onclick = ()=>{
    const nav = el.dataset.nav;
    if (nav==='home') { $$('[data-nav]').forEach(e=>e.classList.remove('on')); showView('home'); }
    else if (nav==='k8sdash') { showView('k8s'); initK8sDash(); }
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key==='b') { e.preventDefault(); setSidebar(!sbHidden,true); }
  });

  // Sidebar hover-to-peek — triggered by hovering the sb-strip OR the hover zone
  const hoverZone = $('sbHoverZone');
  const sbStrip   = $('sbStrip');

  function startPeek() {
    if (!sbHidden) return;
    clearTimeout(sbPeekTimer);
    sbPeekTimer = setTimeout(() => {
      sbPeeking = true;
      $('sidebar').classList.add('peek');
    }, 80);
  }

  function endPeek(e) {
    clearTimeout(sbPeekTimer);
    // Don't close if moving into the sidebar or the strip itself
    const rel = e.relatedTarget;
    const sb  = $('sidebar');
    if (sb.contains(rel) || sbStrip?.contains(rel) || rel === sb || rel === sbStrip) return;
    setTimeout(() => {
      if (sbPeeking && !$('sidebar').matches(':hover') && !sbStrip?.matches(':hover')) {
        sbPeeking = false;
        $('sidebar').classList.remove('peek');
      }
    }, 60);
  }

  // Hover zone (thin strip after sidebar hides)
  hoverZone.addEventListener('mouseenter', startPeek);
  hoverZone.addEventListener('mouseleave', endPeek);

  // sb-strip hover also opens sidebar
  if (sbStrip) {
    sbStrip.addEventListener('mouseenter', startPeek);
    sbStrip.addEventListener('mouseleave', endPeek);
  }

  // Sidebar mouse leave closes it
  $('sidebar').addEventListener('mouseleave', (e) => {
    if (!sbHidden || !sbPeeking) return;
    const rel = e.relatedTarget;
    if (hoverZone.contains(rel) || rel === hoverZone || sbStrip?.contains(rel) || rel === sbStrip) return;
    sbPeeking = false;
    $('sidebar').classList.remove('peek');
  });

  // Sidebar nav items
  $$('[data-nav]').forEach(el => el.onclick = ()=>{
    $$('[data-nav]').forEach(e=>e.classList.remove('on')); el.classList.add('on');
    const nav = el.dataset.nav;
    if (nav==='k8s') { showView('term'); if(el.dataset.cmd) sendCmd(el.dataset.cmd+'\r'); }
    else if (nav==='home') showView('home');
    else navTo(nav);
    // Auto-close sidebar on mobile-ish or if peeking
    if (sbHidden && sbPeeking) { sbPeeking=false; $('sidebar').classList.remove('peek'); }
  });

  // Theme dots (topbar)
  $$('.tdot').forEach(d=>d.onclick=()=>applyTheme(d.dataset.t,true));

  // Color panel
  $('cpClose').onclick = toggleCP;

  // Tab switcher
  $$('.cp-tab').forEach(t=>t.onclick=()=>{
    $$('.cp-tab').forEach(x=>x.classList.remove('on')); t.classList.add('on');
    const tab=t.dataset.cptab;
    $('cptab-terminal').classList.toggle('hide', tab!=='terminal');
    $('cptab-sidebar').classList.toggle('hide', tab!=='sidebar');
  });

  // ── TERMINAL TAB ──
  $$('.tc').forEach(c=>c.onclick=()=>applyTheme(c.dataset.t,true));
  $('fminus').onclick = ()=>applyFont(settings.fontSize-1);
  $('fplus').onclick  = ()=>applyFont(settings.fontSize+1);
  $('fontFam').onchange = e=>{ settings.fontFamily=e.target.value; tabs.forEach(t=>{if(t.term) t.term.options.fontFamily=settings.fontFamily;}); saveCfg(); };
  $('opSlider').oninput = e=>{
    settings.opacity=+e.target.value;
    $('opVal').textContent=settings.opacity+'%';
    if (settings.termTransparent) {
      const darkness = (100 - settings.opacity) / 100;
      $('term-wrap').style.setProperty('--term-overlay', `rgba(0,0,0,${darkness.toFixed(2)})`);
    } else {
      $('term-wrap').style.opacity = settings.opacity / 100;
    }
    saveCfg();
  };
  // Window-level transparency (desktop shows through)
  if ($('winOpSlider')) {
    $('winOpSlider').oninput = e => {
      settings.winOpacity = +e.target.value;
      $('winOpVal').textContent = settings.winOpacity + '%';
      window.roshi.setWinOpacity(settings.winOpacity / 100);
      saveCfg();
    };
  }
  // Terminal transparency toggle
  if ($('btnTermTransp')) {
    $('btnTermTransp').onclick = () => applyTermTransparency(!settings.termTransparent, true);
  }
  $('lineHeightSlider').oninput = e=>{ settings.lineHeight=+e.target.value; $('lineHeightVal').textContent=e.target.value; tabs.forEach(t=>{if(t.term) t.term.options.lineHeight=settings.lineHeight;}); saveCfg(); };
  $('letterSpacingSlider').oninput = e=>{ settings.letterSpacing=+e.target.value; $('letterSpacingVal').textContent=e.target.value+'px'; tabs.forEach(t=>{if(t.term) t.term.options.letterSpacing=settings.letterSpacing;}); saveCfg(); };
  $('scrollbackSlider').oninput = e=>{ settings.scrollback=+e.target.value; $('scrollbackVal').textContent=e.target.value>=1000?(e.target.value/1000).toFixed(0)+'k':e.target.value; saveCfg(); };

  // Cursor style buttons
  $$('[data-cur]').forEach(b=>b.onclick=()=>{
    $$('[data-cur]').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    settings.cursorStyle=b.dataset.cur;
    tabs.forEach(t=>{if(t.term) t.term.options.cursorStyle=settings.cursorStyle;}); saveCfg();
  });
  // Cursor blink buttons
  $$('[data-blink]').forEach(b=>b.onclick=()=>{
    $$('[data-blink]').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    settings.cursorBlink=b.dataset.blink==='true';
    tabs.forEach(t=>{if(t.term) t.term.options.cursorBlink=settings.cursorBlink;}); saveCfg();
  });
  // Font weight buttons
  $$('[data-fw]').forEach(b=>b.onclick=()=>{
    $$('[data-fw]').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    settings.fontWeight=+b.dataset.fw;
    tabs.forEach(t=>{if(t.term) t.term.options.fontWeight=settings.fontWeight;}); saveCfg();
  });

  // Custom terminal colors
  ['TermBg','TermFg','TermCursor','TermSel'].forEach(k=>{
    const key='cp'+k, settKey=k[0].toLowerCase()+k.slice(1).replace('Term','term');
    const el=$('cp'+k), hex=$('cp'+k+'Hex');
    if(!el) return;
    el.oninput=()=>{
      const v=el.value; hex.textContent=v;
      const sk='term'+k.replace('Term',''); settings['term'+k.replace('Term','').toLowerCase().replace(/^./, c=>c.toLowerCase())]=v;
      // map key names
      const map={TermBg:'termBg',TermFg:'termFg',TermCursor:'termCursor',TermSel:'termSel'};
      settings[map[k]]=v;
      tabs.forEach(t=>{if(t.term) t.term.options.theme=xtermTheme();}); saveCfg();
    };
  });
  $('resetTermColors').onclick=()=>{ settings.termBg='';settings.termFg='';settings.termCursor='';settings.termSel=''; tabs.forEach(t=>{if(t.term) t.term.options.theme=xtermTheme();}); saveCfg(); showToast('Terminal colors reset'); };

  // ── SIDEBAR TAB ──
  $$('.sbt').forEach(s=>s.onclick=()=>applySidebarTheme(s.dataset.sbt, true));
  $$('.accent-dot').forEach(d=>d.onclick=()=>applyAccent(d.dataset.ac, true));
  $('cpAccentCustom').oninput=e=>{ applyAccent(e.target.value, true); $('cpAccentCustomHex').textContent=e.target.value; };
  $('sbFontFam').onchange=e=>{ settings.sbFontFam=e.target.value; applySidebarStyle(); saveCfg(); };
  $('sbFontSize').oninput=e=>{ settings.sbFontSize=+e.target.value; $('sbFontSizeVal').textContent=e.target.value+'px'; applySidebarStyle(); saveCfg(); };
  $('sbWidth').oninput=e=>{ settings.sbWidth=+e.target.value; $('sbWidthVal').textContent=e.target.value+'px'; applySidebarStyle(); saveCfg(); };
  $$('[data-sbpad]').forEach(b=>b.onclick=()=>{
    $$('[data-sbpad]').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    settings.sbPad=b.dataset.sbpad; applySidebarStyle(); saveCfg();
  });
  // Custom sidebar colors
  [['cpSbBg','sbBg'],['cpSbText','sbText'],['cpSbHover','sbHover'],['cpSbBorder','sbBorder']].forEach(([id,sk])=>{
    const el=$(id), hex=$(id+'Hex'); if(!el) return;
    el.oninput=()=>{ settings[sk]=el.value; hex.textContent=el.value; applySidebarStyle(); saveCfg(); };
  });
  $('resetSbColors').onclick=()=>{ settings.sbBg='';settings.sbText='';settings.sbHover='';settings.sbBorder=''; applySidebarTheme(settings.sbTheme,false); saveCfg(); showToast('Sidebar reset'); };

  // ── WALLPAPER ──
  $$('[data-wp]').forEach(w=>w.onclick=()=>{ applyWallpaper(w.dataset.wp, true); });
  $$('[data-wptarget]').forEach(b=>b.onclick=()=>{
    $$('[data-wptarget]').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    settings.wpTarget=b.dataset.wptarget; applyWallpaper(settings.wallpaper, true);
  });
  $('wpOpacity').oninput=e=>{ settings.wpOpacity=+e.target.value; $('wpOpacityVal').textContent=e.target.value+'%'; updateWallpaperOpacity(); saveCfg(); };
  $('btnPickWallpaper').onclick=()=>$('wpFilePicker').click();
  $('btnClearWallpaper').onclick=()=>{ settings.customWpImage=''; $('wpImageName').textContent=''; applyWallpaper(settings.wallpaper, true); showToast('Image cleared'); };
  $('wpFilePicker').onchange=e=>{
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      settings.customWpImage=ev.target.result;
      $('wpImageName').textContent='📷 '+file.name;
      applyWallpaper('image', true);
      // Select none in grid since custom image is active
      $$('[data-wp]').forEach(w=>w.classList.remove('on'));
    };
    reader.readAsDataURL(file);
  };

  // K8s cmds
  $$('.k8s-cmd').forEach(b=>b.onclick=()=>sendCmd(b.dataset.cmd+'\r'));

  // Mouse wheel font size (Ctrl+Scroll on terminal)
  $('term-wrap').addEventListener('wheel', e=>{
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    applyFont(settings.fontSize + delta, true);
  }, { passive:false });

  // Monitor buttons
  $('monStartBtn').onclick   = startMonitor;
  $('monStopBtn').onclick    = stopMonitor;
  $('monModeLocal').onclick  = ()=>setMonMode('local');
  $('monModeRemote').onclick = ()=>setMonMode('remote');

  // Modal
  $('mClose').onclick       = closeModal;
  $('modalOverlay').onclick = e=>{ if(e.target===$('modalOverlay')) closeModal(); };
  $('btnSave').onclick      = saveAndConnect;
  $('btnTest').onclick      = testConn;
  $('btnDel').onclick       = deleteSession;
  $('btnBrowse').onclick    = browseKey;
  $$('.at').forEach(t=>t.onclick=()=>{
    $$('.at').forEach(x=>x.classList.remove('on')); t.classList.add('on');
    selAuth=t.dataset.auth;
    $('apPwd').classList.toggle('hide',selAuth!=='password');
    $('apKey').classList.toggle('hide',selAuth!=='key');
  });
  $$('.ctag').forEach(tag=>tag.onclick=()=>{
    $$('.ctag').forEach(x=>x.classList.remove('on')); tag.classList.add('on');
    selColor=tag.dataset.c;
  });
}

// ── SIDEBAR AUTO-HIDE ──────────────────────────────────────────────────────
function setSidebar(hide, save) {
  sbHidden = hide;
  const sb = $('sidebar');
  const toggle = $('sbToggle');
  const hoverZone = $('sbHoverZone');
  const hint = $('sbHint');

  if (hide) {
    sb.classList.add('hidden');
    sb.classList.remove('peek');
    document.body.classList.add('sb-hidden');
    hoverZone.style.display = 'block';
    toggle.textContent = '▶';
    toggle.title = 'Show Sidebar (Ctrl+B)';
  } else {
    sb.classList.remove('hidden','peek');
    document.body.classList.remove('sb-hidden');
    hoverZone.style.display = 'none';
    sbPeeking = false;
    toggle.textContent = '☰';
    toggle.title = 'Hide Sidebar (Ctrl+B)';
  }

  // Refit terminal after transition
  setTimeout(()=>{ try { activeT()?.fit?.fit(); } catch(e){} }, 280);

  if (save) { settings.sidebarHidden = hide; saveCfg(); }
  // Update strip toggle highlight
  const stripToggle = $('sbStripToggle');
  if (stripToggle) stripToggle.classList.toggle('on', !hide);
}

// ── THEME ──────────────────────────────────────────────────────────────────
function applyTheme(t, save) {
  const allThemes = ['t-dracula','t-nord','t-monokai','t-gruvbox','t-cyber','t-solar','t-midnight','t-forest','t-volcano','t-ocean','t-rose','t-glass','t-moba','t-light'];
  allThemes.forEach(c=>document.body.classList.remove(c));
  if (t!=='default') document.body.classList.add('t-'+t);
  settings.theme=t;
  $$('.tdot').forEach(d=>d.classList.toggle('on',d.dataset.t===t));
  $$('.tc').forEach(c=>c.classList.toggle('on',c.dataset.t===t));
  tabs.forEach(tab=>{ if(tab.term) tab.term.options.theme=xtermTheme(); });
  if (save) { showToast('Theme: '+t); saveCfg(); }
}

function xtermTheme() {
  const T = {
    default:  { bg:'#0c0c0c',fg:'#e8e8e8',cur:'#00e5ff',grn:'#39ff6e',red:'#ff4757',yel:'#ffa502',blu:'#5b8fff',mag:'#bc8cff',cyn:'#00e5ff' },
    dracula:  { bg:'#1e1f29',fg:'#f8f8f2',cur:'#bd93f9',grn:'#50fa7b',red:'#ff5555',yel:'#ffb86c',blu:'#6272a4',mag:'#ff79c6',cyn:'#8be9fd' },
    nord:     { bg:'#2e3440',fg:'#eceff4',cur:'#88c0d0',grn:'#a3be8c',red:'#bf616a',yel:'#ebcb8b',blu:'#5e81ac',mag:'#b48ead',cyn:'#88c0d0' },
    monokai:  { bg:'#1e1f1c',fg:'#f8f8f2',cur:'#f8f8f0',grn:'#a6e22e',red:'#f92672',yel:'#e6db74',blu:'#66d9e8',mag:'#ae81ff',cyn:'#66d9e8' },
    gruvbox:  { bg:'#1d2021',fg:'#ebdbb2',cur:'#fabd2f',grn:'#b8bb26',red:'#fb4934',yel:'#fabd2f',blu:'#83a598',mag:'#d3869b',cyn:'#8ec07c' },
    cyber:    { bg:'#050508',fg:'#e0e0ff',cur:'#ff0055',grn:'#00ff88',red:'#ff0055',yel:'#ffcc00',blu:'#00fff2',mag:'#ff00aa',cyn:'#00fff2' },
    solar:    { bg:'#001f27',fg:'#839496',cur:'#2aa198',grn:'#859900',red:'#dc322f',yel:'#b58900',blu:'#268bd2',mag:'#6c71c4',cyn:'#2aa198' },
    midnight: { bg:'#0d0d1a',fg:'#e0e0ff',cur:'#7c83ff',grn:'#ff6ec7',red:'#ff4757',yel:'#ffd700',blu:'#7c83ff',mag:'#ff6ec7',cyn:'#a78bfa' },
    forest:   { bg:'#0d1a0d',fg:'#d4edda',cur:'#7fff7f',grn:'#7fff7f',red:'#ff6b6b',yel:'#ffd700',blu:'#74c7ec',mag:'#cba6f7',cyn:'#94e2d5' },
    volcano:  { bg:'#1a0a00',fg:'#ffecd2',cur:'#ff6b35',grn:'#ffd700',red:'#ff4500',yel:'#ffd700',blu:'#ff8c42',mag:'#ff6b9d',cyn:'#ff6b35' },
    ocean:    { bg:'#001b2e',fg:'#caf0f8',cur:'#00cfff',grn:'#00e8b0',red:'#ff4757',yel:'#ffd166',blu:'#00b4d8',mag:'#90e0ef',cyn:'#00cfff' },
    rose:     { bg:'#1a0a0f',fg:'#ffe4e6',cur:'#ff7eb3',grn:'#ffc0cb',red:'#ff4757',yel:'#ffd700',blu:'#c77dff',mag:'#ff7eb3',cyn:'#ffb3c6' },
    glass:    { bg:'#ffffff0d',fg:'#ffffff',cur:'#ffffff',grn:'#a0ffa0',red:'#ff6b6b',yel:'#ffe066',blu:'#82b4ff',mag:'#d4a0ff',cyn:'#80ffef' },
    moba:     { bg:'#1a1a2e',fg:'#e0e0e0',cur:'#00ff88',grn:'#00ff88',red:'#ff5555',yel:'#ffcc00',blu:'#5bc0de',mag:'#d670d6',cyn:'#5bc0de' },
    light:    { bg:'#f5f5f5',fg:'#1a1a1a',cur:'#0066cc',grn:'#006600',red:'#cc0000',yel:'#996600',blu:'#0066cc',mag:'#660066',cyn:'#006666' },
  };
  const th = T[settings.theme] || T.default;
  // Allow custom color overrides
  const bg  = settings.termBg     || th.bg;
  const fg  = settings.termFg     || th.fg;
  const cur = settings.termCursor || th.cur;
  const sel = settings.termSel    || th.cur;
  return {
    background:bg, foreground:fg, cursor:cur, cursorAccent:bg,
    selectionBackground:sel+'44',
    black:'#1a1a1a', red:th.red, green:th.grn, yellow:th.yel,
    blue:th.blu, magenta:th.mag, cyan:th.cyn, white:th.fg,
    brightBlack:'#555', brightRed:th.red, brightGreen:th.grn, brightYellow:th.yel,
    brightBlue:th.blu, brightMagenta:th.mag, brightCyan:th.cyn, brightWhite:'#fff',
  };
}

function applyFont(size, fromWheel) {
  settings.fontSize = Math.max(8, Math.min(32, size));
  $('fval').textContent = settings.fontSize+'px';
  tabs.forEach(t=>{ if(t.term){ t.term.options.fontSize=settings.fontSize; t.fit?.fit(); } });
  if (fromWheel) {
    const ft = $('fontToast');
    ft.textContent = settings.fontSize+'px';
    ft.classList.add('show');
    clearTimeout(fontToastTmr);
    fontToastTmr = setTimeout(()=>ft.classList.remove('show'), 1000);
  }
  saveCfg();
}

// ── SIDEBAR THEME / ACCENT / STYLE ────────────────────────────────────────────
const SB_THEMES = {
  dark:    { bg:'#0c0c0c', text:'#999', hover:'#181818', border:'#2a2a2a' },
  darker:  { bg:'#050505', text:'#888', hover:'#111',    border:'#1a1a1a' },
  glass:   { bg:'rgba(255,255,255,0.06)', text:'#ccc', hover:'rgba(255,255,255,0.1)', border:'rgba(255,255,255,0.12)' },
  navy:    { bg:'#0d1b2a', text:'#8eafc4', hover:'#152333', border:'#1e3448' },
  forest:  { bg:'#0d1a0d', text:'#7eb87e', hover:'#132013', border:'#1a2e1a' },
  wine:    { bg:'#1a0a10', text:'#c08090', hover:'#220d16', border:'#2e1520' },
  slate:   { bg:'#1e2a3a', text:'#88a0b8', hover:'#253344', border:'#2e3f52' },
  carbon:  { bg:'#1a1a1a', text:'#aaa',   hover:'#222',    border:'#333' },
  moba:    { bg:'#1a1a2e', text:'#c0c0e0', hover:'#252540', border:'#3a3a5a' },
  light:   { bg:'#f0f2f5', text:'#333344', hover:'#e0e4ea', border:'#c0c8d0' },
  // Cyberpunk themes
  cyber:   { bg:'#05080f', text:'#00e5ff', hover:'#0a1520', border:'#00e5ff33' },
  neonpurple: { bg:'#0d0a1e', text:'#bc8cff', hover:'#130f2a', border:'#bc8cff33' },
  matrix:  { bg:'#030d03', text:'#39ff6e', hover:'#071407', border:'#39ff6e33' },
  neonred: { bg:'#120505', text:'#ff4757', hover:'#1a0808', border:'#ff475733' },
  ocean:   { bg:'#050e1a', text:'#00cfff', hover:'#081828', border:'#00cfff33' },
  gold:    { bg:'#110e00', text:'#ffd700', hover:'#1a1500', border:'#ffd70033' },
};

function applySidebarTheme(sbt, save) {
  settings.sbTheme = sbt;
  $$('.sbt').forEach(s=>s.classList.toggle('on', s.dataset.sbt===sbt));
  applySidebarStyle();
  if (save) saveCfg();
}

function applyAccent(color, save) {
  settings.sbAccent = color;
  $$('.accent-dot').forEach(d=>d.classList.toggle('on', d.dataset.ac===color));
  // Apply accent as CSS variable override
  document.documentElement.style.setProperty('--cyan', color);
  // Update color pickers
  if ($('cpAccentCustom')) $('cpAccentCustom').value = color.length===7 ? color : '#00e5ff';
  if ($('cpAccentCustomHex')) $('cpAccentCustomHex').textContent = color;
  if (save) { saveCfg(); }
}

function applySidebarStyle() {
  const th = SB_THEMES[settings.sbTheme] || SB_THEMES.dark;
  const sb = $('sidebar');
  if (!sb) return;
  const bg     = settings.sbBg     || th.bg;
  const text   = settings.sbText   || th.text;
  const hover  = settings.sbHover  || th.hover;
  const bdr    = settings.sbBorder || th.border;
  const pad    = { compact:'7px 12px', normal:'10px 14px', spacious:'14px 16px' }[settings.sbPad] || '7px 12px';

  sb.style.background   = bg;
  sb.style.borderColor  = bdr;
  sb.style.fontFamily   = settings.sbFontFam !== 'inherit' ? settings.sbFontFam : '';
  sb.style.fontSize     = settings.sbFontSize + 'px';
  sb.style.width        = settings.sbWidth + 'px';

  // Inject dynamic CSS for hover/active states and item padding
  let styleEl = document.getElementById('sb-dynamic-style');
  if (!styleEl) { styleEl = document.createElement('style'); styleEl.id='sb-dynamic-style'; document.head.appendChild(styleEl); }
  styleEl.textContent = `
    .sidebar { background: ${bg} !important; border-color: ${bdr} !important; }
    .sb-item { color: ${text}; padding: ${pad}; }
    .sb-item:hover, .sb-item.on { background: ${hover} !important; color: #fff; }
    .sb-lbl { color: ${text}88; }
    .sess-row { color: ${text}; }
    .sess-row:hover, .sess-row.on { background: ${hover} !important; }
    .sb-add { color: ${text}; }
    .sb-add:hover { background: ${hover}; }
    .sname { color: ${text}; font-size: ${settings.sbFontSize}px; }
    .shost { color: ${text}99; font-size: ${Math.max(settings.sbFontSize - 2, 10)}px; }
    .sb-lbl { font-size: ${Math.max(settings.sbFontSize - 2, 10)}px; }
    .sess-row:hover .sname, .sess-row.on .sname { color: #fff; text-shadow: 0 0 8px ${settings.sbAccent}; }
    .sess-row:hover .sdot, .sess-row.on .sdot { box-shadow: 0 0 6px currentColor; }
    .sb-item.on { text-shadow: 0 0 10px ${settings.sbAccent}88; }
    .sb-item:hover { text-shadow: 0 0 8px ${settings.sbAccent}66; }
    .sdot { box-shadow: none; transition: box-shadow 0.3s; }
  `;

  // Update sync color picker values in panel
  if ($('cpSbBg'))     { $('cpSbBg').value     = colorToHex(bg);    $('cpSbBgHex').textContent    = colorToHex(bg); }
  if ($('cpSbText'))   { $('cpSbText').value   = colorToHex(text);  $('cpSbTextHex').textContent  = colorToHex(text); }
  if ($('cpSbHover'))  { $('cpSbHover').value  = colorToHex(hover); $('cpSbHoverHex').textContent = colorToHex(hover); }
  if ($('cpSbBorder')) { $('cpSbBorder').value = colorToHex(bdr);   $('cpSbBorderHex').textContent= colorToHex(bdr); }
}

function colorToHex(c) {
  if (!c || c.startsWith('rgba') || c.startsWith('rgb')) return '#111111';
  return c.startsWith('#') ? c : '#111111';
}

function restoreCpanelUI() {
  // Restore terminal tab UI
  if ($('opSlider'))          { $('opSlider').value = settings.opacity; $('opVal').textContent = settings.opacity+'%'; }
  if ($('winOpSlider'))       { $('winOpSlider').value = settings.winOpacity||100; $('winOpVal').textContent = (settings.winOpacity||100)+'%'; }
  if ($('lineHeightSlider'))  { $('lineHeightSlider').value = settings.lineHeight; $('lineHeightVal').textContent = settings.lineHeight; }
  if ($('letterSpacingSlider')){ $('letterSpacingSlider').value = settings.letterSpacing; $('letterSpacingVal').textContent = settings.letterSpacing+'px'; }
  if ($('scrollbackSlider'))  { $('scrollbackSlider').value = settings.scrollback; $('scrollbackVal').textContent = settings.scrollback>=1000?(settings.scrollback/1000).toFixed(0)+'k':settings.scrollback; }
  $$('[data-cur]').forEach(b=>b.classList.toggle('on', b.dataset.cur===settings.cursorStyle));
  $$('[data-blink]').forEach(b=>b.classList.toggle('on', b.dataset.blink===String(settings.cursorBlink)));
  $$('[data-fw]').forEach(b=>b.classList.toggle('on', +b.dataset.fw===settings.fontWeight));
  // Restore sidebar tab UI
  $$('[data-sbpad]').forEach(b=>b.classList.toggle('on', b.dataset.sbpad===settings.sbPad));
  if ($('sbFontFam'))  { $('sbFontFam').value = settings.sbFontFam; }
  if ($('sbFontSize')) { $('sbFontSize').value = settings.sbFontSize; $('sbFontSizeVal').textContent = settings.sbFontSize+'px'; }
  if ($('sbWidth'))    { $('sbWidth').value = settings.sbWidth; $('sbWidthVal').textContent = settings.sbWidth+'px'; }
  $$('.accent-dot').forEach(d=>d.classList.toggle('on', d.dataset.ac===settings.sbAccent));
  $$('[data-wp]').forEach(w=>w.classList.toggle('on', w.dataset.wp===settings.wallpaper));
  $$('[data-wptarget]').forEach(b=>b.classList.toggle('on', b.dataset.wptarget===settings.wpTarget));
  if(settings.customWpImage && $('wpImageName')) $('wpImageName').textContent='📷 Custom image loaded';
  if($('wpOpacity')){ $('wpOpacity').value=settings.wpOpacity; $('wpOpacityVal').textContent=settings.wpOpacity+'%'; }
  applySidebarStyle();
}

// ── IMAGE WALLPAPER ──────────────────────────────────────────────────────────
function drawImageWallpaper(src) {
  const target  = settings.wpTarget || 'terminal';
  const showTerm = target==='terminal'||target==='both';
  const showHome = target==='home'||target==='both';
  const op = (settings.wpOpacity/100).toFixed(2);
  const termCanvas = $('wallpaperCanvas');
  const homeCanvas = $('homeCanvas');

  const img = new Image();
  img.onload = () => {
    const canvases = [];
    if (showTerm && termCanvas) canvases.push(termCanvas);
    if (showHome && homeCanvas) canvases.push(homeCanvas);
    canvases.forEach(c => {
      const W = c.offsetWidth  || c.parentElement?.offsetWidth  || window.innerWidth  || 1280;
      const H = c.offsetHeight || c.parentElement?.offsetHeight || window.innerHeight || 720;
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      // Cover fit
      const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const dw = img.naturalWidth  * scale;
      const dh = img.naturalHeight * scale;
      const dx = (W - dw) / 2;
      const dy = (H - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
      c.style.opacity = op;
    });
    if (showTerm) {
      document.body.classList.add('wp-active');
      tabs.forEach(t=>{ if(t.term) t.term.options.theme={...xtermTheme(),background:'transparent'}; });
    }
    if (showHome) {
      const hgrid = $('hgrid');
      if (hgrid) hgrid.style.opacity = '0'; // hide grid when image shown
    }
  };
  img.onerror = e => {
    console.error('Image load error:', e);
    showToast('Could not load image — try a smaller file or different format');
  };
  // Set crossOrigin before src for object URLs
  img.src = src;
}

// ── WALLPAPER ENGINE ─────────────────────────────────────────────────────────
let wpAnimFrames = []; // track ALL running animation frame IDs

function cancelAllWpFrames() {
  wpAnimFrames.forEach(id => cancelAnimationFrame(id));
  wpAnimFrames = [];
}

function trackWpFrame(id) {
  wpAnimFrames.push(id);
  return id;
}

function applyWallpaper(wp, save) {
  if (wp !== 'image') settings.wallpaper = wp;
  $$('[data-wp]').forEach(w=>w.classList.toggle('on', w.dataset.wp===wp));

  // Stop ALL previous animations
  cancelAllWpFrames();

  const target = settings.wpTarget || 'terminal';
  const termCanvas = $('wallpaperCanvas');
  const homeCanvas = $('homeCanvas');
  const op = (settings.wpOpacity/100).toFixed(2);

  // Hide all first
  if (termCanvas) { termCanvas.style.opacity='0'; termCanvas.style.transform=''; }
  if (homeCanvas) { homeCanvas.style.opacity='0'; homeCanvas.style.transform=''; }
  document.body.classList.remove('wp-active');
  // Reset perspective on parent containers
  [termCanvas, homeCanvas].forEach(c => {
    if (c?.parentElement) { c.parentElement.style.perspective=''; c.parentElement.style.perspectiveOrigin=''; }
  });
  tabs.forEach(t=>{ if(t.term) t.term.options.theme={...xtermTheme()}; });

  if (wp === 'none' && !settings.customWpImage) { if (save) saveCfg(); return; }

  const showTerm = target==='terminal'||target==='both';
  const showHome = target==='home'||target==='both';

  // Custom image wallpaper
  if (wp === 'image' || settings.customWpImage) {
    const img = new Image();
    img.onload = () => {
      [showTerm?termCanvas:null, showHome?homeCanvas:null].forEach(c=>{
        if (!c) return;
        c.width = c.offsetWidth || c.parentElement?.offsetWidth || 1280;
        c.height = c.offsetHeight || c.parentElement?.offsetHeight || 720;
        const ctx2 = c.getContext('2d');
        ctx2.drawImage(img, 0, 0, c.width, c.height);
        c.style.opacity = op;
      });
    };
    img.src = settings.customWpImage;
    if (showTerm) { document.body.classList.add('wp-active'); tabs.forEach(t=>{ if(t.term) t.term.options.theme={...xtermTheme(),background:'transparent'};}); }
    if (save) saveCfg();
    return;
  }

  // Animated wallpapers — defer slightly so canvas has correct dimensions
  setTimeout(() => {
    if (showTerm && termCanvas) {
      termCanvas.style.opacity = op;
      document.body.classList.add('wp-active');
      tabs.forEach(t=>{ if(t.term) t.term.options.theme={...xtermTheme(),background:'transparent'}; });
      const ctx = termCanvas.getContext('2d');
      termCanvas.width = termCanvas.offsetWidth || window.innerWidth || 1280;
      termCanvas.height = termCanvas.offsetHeight || window.innerHeight || 720;
      startWpAnimation(wp, ctx, termCanvas);
    }
    if (showHome && homeCanvas) {
      homeCanvas.style.opacity = op;
      const ctx2 = homeCanvas.getContext('2d');
      homeCanvas.width = homeCanvas.offsetWidth || window.innerWidth || 1280;
      homeCanvas.height = homeCanvas.offsetHeight || window.innerHeight || 720;
      // Always start home animation regardless of showTerm
      startWpAnimation(wp, ctx2, homeCanvas);
    }
  }, 100);

  if (save) saveCfg();
}

function startWpAnimation(wp, ctx, canvas) {
  // Reset any previous transforms
  canvas.style.transform = '';
  canvas.style.willChange = '';

  if (wp === 'roshilabx') drawRoshiLABX(ctx, canvas);
  else if (wp === 'matrix')     drawMatrix(ctx, canvas);
  else if (wp === 'cyber')      drawCyberGrid(ctx, canvas);
  else if (wp === 'stars')      drawStarfield(ctx, canvas);
  else if (wp === 'neon')       drawNeonPulse(ctx, canvas);
  else if (wp === 'ashoka')     drawAshoka(ctx, canvas, false);
  else if (wp === 'ashokvega')  drawAshoka(ctx, canvas, true);
}

function updateWallpaperOpacity() {
  const op = (settings.wpOpacity/100).toFixed(2);
  const target = settings.wpTarget||'terminal';
  const tc=$('wallpaperCanvas'), hc=$('homeCanvas');
  if ((target==='terminal'||target==='both') && tc && parseFloat(tc.style.opacity)>0) tc.style.opacity=op;
  if ((target==='home'||target==='both') && hc && parseFloat(hc.style.opacity)>0) hc.style.opacity=op;
}

// ── RoshiLABX branded wallpaper ──────────────────────────────────────────────
function drawRoshiLABX(ctx, canvas) {
  let t = 0;
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Deep background gradient
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0d0d1a');
    bg.addColorStop(0.5, '#1a0a2e');
    bg.addColorStop(1, '#0a1a2e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Animated grid lines
    ctx.strokeStyle = '#7c83ff18';
    ctx.lineWidth = 1;
    const gs = 60;
    for (let x = (t*0.5)%gs; x < W; x += gs) {
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    }
    for (let y = (t*0.3)%gs; y < H; y += gs) {
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    }

    // Glowing orbs
    const orbs = [
      { x: W*0.2, y: H*0.3, r: 120, c: '#7c83ff' },
      { x: W*0.8, y: H*0.7, r: 100, c: '#ff6ec7' },
      { x: W*0.5, y: H*0.5, r: 80,  c: '#00e8b0' },
    ];
    orbs.forEach(o => {
      const ox = o.x + Math.sin(t*0.008 + o.r)*30;
      const oy = o.y + Math.cos(t*0.006 + o.r)*20;
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, o.r);
      g.addColorStop(0, o.c+'22');
      g.addColorStop(1, o.c+'00');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ox, oy, o.r, 0, Math.PI*2); ctx.fill();
    });

    // Big "ROSHI" text watermark
    const cx = W/2, cy = H/2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // ROSHI
    const rGrad = ctx.createLinearGradient(cx-200, cy-40, cx+200, cy-40);
    rGrad.addColorStop(0, '#7c83ff');
    rGrad.addColorStop(1, '#ff6ec7');
    ctx.font = `900 ${Math.min(W*0.18, 120)}px Arial`;
    ctx.fillStyle = rGrad;
    ctx.globalAlpha = 0.12 + Math.sin(t*0.01)*0.03;
    ctx.fillText('ROSHI', cx, cy - Math.min(H*0.08, 50));

    // LABX
    const lGrad = ctx.createLinearGradient(cx-150, cy+20, cx+150, cy+20);
    lGrad.addColorStop(0, '#00e8b0');
    lGrad.addColorStop(1, '#00cfff');
    ctx.font = `900 ${Math.min(W*0.12, 80)}px Arial`;
    ctx.fillStyle = lGrad;
    ctx.globalAlpha = 0.15 + Math.cos(t*0.008)*0.03;
    ctx.fillText('LABX', cx, cy + Math.min(H*0.08, 50));

    // Small floating particles
    ctx.globalAlpha = 1;
    for (let i = 0; i < 20; i++) {
      const px = (Math.sin(t*0.003*i + i)*0.5+0.5)*W;
      const py = (Math.cos(t*0.002*i + i*2)*0.5+0.5)*H;
      const pr = 1.5 + Math.sin(t*0.01+i)*0.5;
      ctx.fillStyle = ['#7c83ff','#ff6ec7','#00e8b0','#ffd700'][i%4];
      ctx.globalAlpha = 0.4 + Math.sin(t*0.01+i)*0.2;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2); ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
    t++;
    trackWpFrame(requestAnimationFrame(draw));
  }
  draw();
}

// ── Matrix rain ───────────────────────────────────────────────────────────────
function drawMatrix(ctx, canvas) {
  const W = canvas.width, H = canvas.height;
  const cols = Math.floor(W / 16);
  const drops = Array(cols).fill(1);
  const chars = 'ROSHILABX01アイウエオカキクケコサシスセソタ'.split('');

  function draw() {
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#39ff6e';
    ctx.font = '14px monospace';
    drops.forEach((y, i) => {
      const ch = chars[Math.floor(Math.random()*chars.length)];
      ctx.fillStyle = i%5===0 ? '#ffffff' : '#39ff6e';
      ctx.fillText(ch, i*16, y*16);
      if (y*16 > H && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    });
    trackWpFrame(requestAnimationFrame(draw));
  }
  draw();
}

// ── Ashoka Brahmi rain ────────────────────────────────────────────────────────
function drawAshoka(ctx, canvas, fast) {
  const brahmi = [
    '𑀅','𑀆','𑀇','𑀈','𑀉','𑀊','𑀋','𑀌','𑀍','𑀎','𑀏','𑀐','𑀑','𑀒',
    '𑀓','𑀔','𑀕','𑀖','𑀗','𑀘','𑀙','𑀚','𑀛','𑀜',
    '𑀝','𑀞','𑀟','𑀠','𑀡','𑀢','𑀣','𑀤','𑀥','𑀦',
    '𑀧','𑀨','𑀩','𑀪','𑀫','𑀬','𑀭','𑀮','𑀯','𑀰',
    '𑀱','𑀲','𑀳','𑀴','𑀵',
    '𑁒','𑁓','𑁔','𑁕','𑁖','𑁗','𑁘','𑁙','𑁚','𑁛'
  ];

  const fs   = 20;   // font size — large enough to see Brahmi clearly
  const colW = 32;   // wide columns so complex glyphs don't overlap
  const W = canvas.width, H = canvas.height;
  const cols  = Math.floor(W / colW);
  const drops = Array(cols).fill(1);
  const speed = fast ? 1 : 0.4;
  const font  = `${fs}px 'NotoSansBrahmi','Noto Sans Brahmi','Segoe UI Historic',serif`;

  // For slow mode — fractional drops
  const fdrops = Array.from({length: cols}, () => Math.random() * -(H / fs));

  function draw() {
    // Slow fade — keeps characters visible like Matrix
    ctx.fillStyle = fast ? 'rgba(0,0,0,0.05)' : 'rgba(0,0,0,0.03)';
    ctx.fillRect(0, 0, W, H);
    ctx.font = font;

    for (let i = 0; i < cols; i++) {
      const ch = brahmi[Math.floor(Math.random() * brahmi.length)];
      const x  = i * colW;

      if (fast) {
        // Matrix-style: bright gold, white head every ~5 cols
        ctx.fillStyle = i % 5 === 0 ? '#ffffff' : '#ffaa00';
        ctx.fillText(ch, x, drops[i] * fs);
        if (drops[i] * fs > H && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      } else {
        // Slow mode: fractional speed, same bright gold
        const y = fdrops[i] * fs;
        ctx.fillStyle = i % 5 === 0 ? '#ffffff' : '#ffcc44';
        if (y > 0) ctx.fillText(ch, x, y);
        if (y > H && Math.random() > 0.985) fdrops[i] = 0;
        fdrops[i] += speed;
      }
    }

    trackWpFrame(requestAnimationFrame(draw));
  }
  draw();
}

// ── Cyber grid ────────────────────────────────────────────────────────────────
function drawCyberGrid(ctx, canvas) {
  let t = 0;
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, W, H);

    // Perspective grid
    const gy = H * 0.6;
    ctx.strokeStyle = '#00fff240';
    ctx.lineWidth = 1;
    for (let i = -20; i <= 20; i++) {
      const x = W/2 + i*80 + (t*0.5)%80;
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(W/2, H*0.1); ctx.stroke();
    }
    for (let i = 0; i < 10; i++) {
      const y = gy + i*30;
      const spread = (y-gy)/H * W;
      ctx.beginPath(); ctx.moveTo(W/2-spread, y); ctx.lineTo(W/2+spread, y); ctx.stroke();
    }

    // Scan line
    const sy = ((t*2) % (H*1.5));
    const sg = ctx.createLinearGradient(0, sy-40, 0, sy+40);
    sg.addColorStop(0, '#00fff200');
    sg.addColorStop(0.5, '#00fff230');
    sg.addColorStop(1, '#00fff200');
    ctx.fillStyle = sg;
    ctx.fillRect(0, sy-40, W, 80);

    // Watermark
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.min(W*0.15, 100)}px Arial`;
    ctx.fillStyle = '#00fff2';
    ctx.globalAlpha = 0.06;
    ctx.fillText('RoshiLABX', W/2, H/2);
    ctx.globalAlpha = 1;

    t++;
    trackWpFrame(requestAnimationFrame(draw));
  }
  draw();
}

// ── Starfield ─────────────────────────────────────────────────────────────────
function drawStarfield(ctx, canvas) {
  const W = canvas.width, H = canvas.height;
  const stars = Array.from({length:200}, ()=>({
    x:(Math.random()-0.5)*W*3, y:(Math.random()-0.5)*H*3,
    z:Math.random()*W, pz:0
  }));
  let t = 0;
  function draw() {
    ctx.fillStyle = '#000510';
    ctx.fillRect(0, 0, W, H);
    stars.forEach(s => {
      s.pz = s.z;
      s.z -= 3;
      if (s.z <= 0) { s.x=(Math.random()-0.5)*W*3; s.y=(Math.random()-0.5)*H*3; s.z=W; s.pz=W; }
      const sx = (s.x/s.z)*W + W/2;
      const sy = (s.y/s.z)*H + H/2;
      const px = (s.x/s.pz)*W + W/2;
      const py = (s.y/s.pz)*H + H/2;
      const r = Math.max(0.5, (1-s.z/W)*2.5);
      ctx.strokeStyle = `rgba(255,255,255,${1-s.z/W})`;
      ctx.lineWidth = r;
      ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(sx,sy); ctx.stroke();
    });
    // Watermark
    ctx.textAlign='center'; ctx.font=`900 ${Math.min(W*0.15,100)}px Arial`;
    ctx.fillStyle='#ffffff'; ctx.globalAlpha=0.04+Math.sin(t*0.01)*0.01;
    ctx.fillText('RoshiLABX', W/2, H/2);
    ctx.globalAlpha=1;
    t++;
    trackWpFrame(requestAnimationFrame(draw));
  }
  draw();
}

// ── Neon Pulse ────────────────────────────────────────────────────────────────
function drawNeonPulse(ctx, canvas) {
  let t = 0;
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a000f';
    ctx.fillRect(0, 0, W, H);

    const rings = [
      { c:'#ff6ec7', r:100 }, { c:'#7c83ff', r:160 },
      { c:'#00e8b0', r:220 }, { c:'#ffd700', r:280 },
    ];
    const cx = W/2, cy = H/2;
    rings.forEach((rg, i) => {
      const pulse = rg.r + Math.sin(t*0.02 + i*1.2)*20;
      const g = ctx.createRadialGradient(cx,cy,pulse-8,cx,cy,pulse+8);
      g.addColorStop(0, rg.c+'00');
      g.addColorStop(0.5, rg.c+'60');
      g.addColorStop(1, rg.c+'00');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx,cy,pulse+8,0,Math.PI*2); ctx.fill();
    });

    // Watermark
    ctx.textAlign='center';
    const ng = ctx.createLinearGradient(cx-200,cy,cx+200,cy);
    ng.addColorStop(0,'#ff6ec7'); ng.addColorStop(0.5,'#7c83ff'); ng.addColorStop(1,'#00e8b0');
    ctx.font=`900 ${Math.min(W*0.15,100)}px Arial`;
    ctx.fillStyle=ng;
    ctx.globalAlpha=0.08+Math.sin(t*0.015)*0.02;
    ctx.fillText('RoshiLABX', cx, cy);
    ctx.globalAlpha=1;
    t++;
    trackWpFrame(requestAnimationFrame(draw));
  }
  draw();
}

const saveCfg  = ()=>window.roshi.saveSettings(settings);
const saveSess = ()=>window.roshi.saveSessions(sessions);

// ── VIEWS ──────────────────────────────────────────────────────────────────
function showView(id) {
  $$('.view').forEach(v=>v.classList.remove('on'));
  $('v-'+id)?.classList.add('on');
  const isTerm = id==='term';
  $('connBar').classList.toggle('hide',!isTerm);
  if (isTerm) {
    $$('.xterm-host').forEach(el=>el.style.display='none');
    const t=activeT(); if(t?.el) t.el.style.display='flex';
    updateConnBar();
    setTimeout(()=>{ try{activeT()?.fit?.fit();}catch(e){} },80);
  }
  // Update monitor view state
  if (id==='mon') updateMonitorView();
  if (id==='k8s') { /* handled by initK8sDash */ }
}

function navTo(v) {
  $$('[data-nav]').forEach(e=>e.classList.remove('on'));
  document.querySelector(`[data-nav="${v}"]`)?.classList.add('on');
  if (v === 'k8sdash') { showView('k8s'); initK8sDash(); }
  else showView(v);
}

// ── SESSIONS SIDEBAR ───────────────────────────────────────────────────────
function renderSessList() {
  const list=$('sessList'); list.innerHTML='';
  sessions.forEach(s=>{
    const el=document.createElement('div');
    el.className='sess-row'; el.id='srow-'+s.id;
    el.innerHTML=`<div class="sdot off" id="dot-${s.id}"></div>
      <div class="sinfo"><div class="sname">${esc(s.label)}</div>
      <div class="shost">${esc(s.username)}@${esc(s.host)}:${s.port||22}</div></div>
      <button class="sedit" title="Edit">✎</button>`;
    el.querySelector('.sedit').onclick=e=>{e.stopPropagation();openModal(s.id);};
    el.onclick=()=>connectSession(s.id);
    list.appendChild(el);
  });
}
function setDot(sessId,state){ const d=$('dot-'+sessId); if(d) d.className='sdot '+state; }

// ── TABS ───────────────────────────────────────────────────────────────────
let dragSrcTabId = null;

function renderTabs() {
  const list=$('tabList'); list.innerHTML='';
  const shellLabels={powershell:'PowerShell',cmd:'CMD',bash:'Bash',cygwin:'Cygwin',gitbash:'Git Bash',pwsh:'PS Core',wslbash:'WSL Bash',cmd_fallback:'CMD'};
  tabs.forEach(tab=>{
    const s=getSess(tab.sessId);
    const color=tab.isLocal?(tab.connected?'#39ff6e':'#333'):(tab.connected?(s?.color||'#39ff6e'):'#333');
    const el=document.createElement('div');
    el.className='tab'+(tab.id===activeTabId?' on':'');
    const tabName = tab.isLocal ? (shellLabels[tab.shellPref]||'Terminal') : esc(s?.label||'Terminal');
    el.innerHTML=`<div class="tab-dot" style="background:${color}"></div>
      <span class="tab-label">${tabName}</span>
      <div class="tab-x" data-id="${tab.id}">✕</div>`;
    el.onclick=e=>{if(!e.target.classList.contains('tab-x')) switchTab(tab.id);};
    el.querySelector('.tab-x').onclick=e=>{e.stopPropagation();closeTab(tab.id);};

    // Drag and drop reordering
    el.draggable = true;
    el.dataset.tabId = tab.id;

    el.addEventListener('dragstart', e => {
      dragSrcTabId = tab.id;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('tab-dragging'), 0);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('tab-dragging');
      $$('.tab-drag-over').forEach(t => t.classList.remove('tab-drag-over'));
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (tab.id !== dragSrcTabId) {
        $$('.tab-drag-over').forEach(t => t.classList.remove('tab-drag-over'));
        el.classList.add('tab-drag-over');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (dragSrcTabId && dragSrcTabId !== tab.id) {
        const fromIdx = tabs.findIndex(t => t.id === dragSrcTabId);
        const toIdx   = tabs.findIndex(t => t.id === tab.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = tabs.splice(fromIdx, 1);
          tabs.splice(toIdx, 0, moved);
          renderTabs();
        }
      }
      dragSrcTabId = null;
    });

    list.appendChild(el);
  });
}
function switchTab(id){ activeTabId=id; renderTabs(); showView('term'); }
function closeTab(id){
  const t=getTab(id);
  if(t){
    if(t.isLocal) { try{window.roshi.localStop(id);}catch(e){} }
    else { try{window.roshi.disconnect(id);}catch(e){} }
    t.el?.remove();
    if(t.sessId) setDot(t.sessId,'off');
    if(monTabId===id) stopMonitor();
  }
  tabs=tabs.filter(t=>t.id!==id);
  activeTabId=tabs.length?tabs[tabs.length-1].id:null;
  renderTabs();
  if(!tabs.length) {
    showView('home');
    setSidebar(false, true); // re-show sidebar when going home
  } else switchTab(activeTabId);
}
const activeT = ()=>tabs.find(t=>t.id===activeTabId);
const getTab  = id=>tabs.find(t=>t.id===id);
const getSess = id=>sessions.find(s=>s.id===id);

// ── TERMINAL ───────────────────────────────────────────────────────────────
function makeTerminal(tabId) {
  const wrap=$('term-wrap');
  const host=document.createElement('div');
  host.className='xterm-host';
  host.style.cssText='flex:1;display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;';
  // Insert before fontToast
  wrap.insertBefore(host, $('fontToast'));

  const termTheme = settings.wallpaper && settings.wallpaper !== 'none'
    ? {...xtermTheme(), background:'transparent'}
    : xtermTheme();
  const term=new Terminal({
    theme:termTheme, fontSize:settings.fontSize,
    fontFamily:settings.fontFamily, cursorStyle:settings.cursorStyle,
    cursorBlink:settings.cursorBlink, scrollback:settings.scrollback,
    fontWeight:settings.fontWeight, lineHeight:settings.lineHeight,
    letterSpacing:settings.letterSpacing, macOptionIsMeta:true,
    scrollOnUserInput:true, fastScrollModifier:'alt',
    smoothScrollDuration:0,
    windowsMode:true,
  });
  const fit=new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Use Canvas renderer for much better scroll/redraw performance
  try {
    if (window.CanvasAddon) {
      term.loadAddon(new CanvasAddon.CanvasAddon());
    }
  } catch(e) { console.warn('Canvas addon not available:', e); }
  setTimeout(()=>{ try{fit.fit();}catch(e){} },100);

  // NOTE: onData is NOT bound here - bound by the caller (SSH or local)
  // This prevents the SSH handler from hijacking local terminal input

  // ── COPY on select ───────────────────────────────────────────────────────
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) window.roshi.clipboardWrite(sel);
  });

  // ── PASTE on right click ─────────────────────────────────────────────────
  host.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    try {
      const text = await window.roshi.clipboardRead();
      if (text) {
        const t = tabs.find(tb => tb.id === tabId);
        if (t?.isLocal) window.roshi.localInput(tabId, text);
        else window.roshi.sendInput(tabId, text);
      }
    } catch(err) { console.error('Paste error:', err); }
  });

  term.onResize(({cols,rows})=>{
    try {
      window.roshi.resizeTerm(tabId,cols,rows);
    } catch(e) {}
  });

  let roTimer = null;
  const ro = new ResizeObserver(() => {
    // Debounce resize to avoid rapid firing
    clearTimeout(roTimer);
    roTimer = setTimeout(() => {
      try {
        fit.fit();
        const t = tabs.find(tb => tb.id === tabId);
        if (t?.connected) {
          window.roshi.resizeTerm(tabId, term.cols, term.rows);
          term.refresh(0, term.rows - 1);
        }
      } catch(e) {}
    }, 50);
  });
  ro.observe(wrap);
  return {term,fit,el:host};
}

// ── LOCAL TERMINAL ───────────────────────────────────────────────────────────────
async function openLocalTerminal(shellPref) {
  shellPref = shellPref || 'gitbash';
  const shellLabels = { powershell:'PowerShell', cmd:'CMD', bash:'Bash', cygwin:'Cygwin', gitbash:'Git Bash', pwsh:'PowerShell Core', wslbash:'WSL Bash', cmd_fallback:'CMD' };
  const label = shellLabels[shellPref] || 'Terminal';
  const tabId = 'local-' + Date.now();

  const tab = { id:tabId, sessId:null, term:null, fit:null, el:null, connected:false, isLocal:true, shellPref };
  tabs.push(tab); activeTabId = tabId; renderTabs();
  $$('.xterm-host').forEach(el => el.style.display = 'none');

  const { term, fit, el } = makeTerminal(tabId);
  tab.term = term; tab.fit = fit; tab.el = el;
  showView('term');
  if (!sbHidden) setSidebar(true, true); // auto-hide sidebar when terminal opens
  $('connBar').classList.remove('hide');
  $('cdot').className = 'cdot ing';
  $('connLbl').textContent = 'Starting ' + label + '...';
  $('connLbl').style.color = 'var(--yel)';
  term.write('\x1b[36mStarting ' + label + '...\x1b[0m\r\n');

  // Fit terminal BEFORE starting PTY so cols/rows are accurate
  try { fit.fit(); } catch(e) {}

  const result = await window.roshi.localStart({ tabId, shell: shellPref, cols: term.cols, rows: term.rows });

  if (result.ok) {
    tab.connected = true;
    $('cdot').className = 'cdot ok';
    $('connLbl').textContent = label + ' — Local';
    $('connLbl').style.color = '#39ff6e';
    renderTabs();

    // Bind local shell input (separate from SSH)
    term.onData(data => { window.roshi.localInput(tabId, data); });

    // Fit first, then send correct size to PTY
    const doResize = () => {
      try {
        fit.fit();
        window.roshi.resizeTerm(tabId, term.cols, term.rows);
        term.refresh(0, term.rows - 1);
      } catch(e) {}
    };
    setTimeout(doResize, 100);
    setTimeout(doResize, 500);
    setTimeout(doResize, 1000);
    setTimeout(doResize, 2000);

    // Restart shell on any key after it exits
    term.onKey(() => {
      if (!tab.connected) {
        tab.connected = true;
        term.write('\r\n\x1b[36mRestarting ' + label + '...\x1b[0m\r\n');
        window.roshi.localStart({ tabId, shell: shellPref, cols: term.cols, rows: term.rows }).then(r => {
          if (r.ok) {
            $('cdot').className = 'cdot ok';
            $('connLbl').style.color = '#39ff6e';
            renderTabs();
            setTimeout(() => {
              try { fit.fit(); } catch(e) {}
            }, 50);
          }
        });
      }
    });
  } else {
    tab.connected = false;
    $('cdot').className = 'cdot err';
    $('connLbl').textContent = 'Shell failed';
    $('connLbl').style.color = 'var(--red)';
    term.write('\x1b[31m✕ Failed to start ' + label + ': ' + result.error + '\x1b[0m\r\n');
    term.write('\x1b[33mTip: Try CMD from the Local dropdown.\x1b[0m\r\n');
    renderTabs();
  }
}

// ── CONNECT SSH ────────────────────────────────────────────────────────────
async function connectSession(sessId) {
  const s=getSess(sessId); if(!s) return;


  const tabId='tab-'+Date.now();
  const tab={id:tabId,sessId,term:null,fit:null,el:null,connected:false};
  tabs.push(tab); activeTabId=tabId; renderTabs();
  $$('.xterm-host').forEach(el=>el.style.display='none');
  const {term,fit,el}=makeTerminal(tabId);
  tab.term=term; tab.fit=fit; tab.el=el;
  showView('term'); setDot(sessId,'ing'); updateConnBar('ing',s);
  if (!sbHidden) setSidebar(true, true); // auto-hide sidebar
  term.write(`\x1b[36mConnecting to \x1b[1m${s.username}@${s.host}:${s.port||22}\x1b[0m\x1b[36m ...\x1b[0m\r\n`);

  let result;
  try {
    result=await window.roshi.connect({
      tabId, host:s.host, port:parseInt(s.port)||22, username:s.username,
      password:s.authType==='password'?s.password:undefined,
      privateKey:s.authType==='key'?s.privateKey:undefined,
      passphrase:s.passphrase||undefined,
    });
  } catch(e){ result={ok:false,error:e.message}; }

  if(result.ok){
    tab.connected=true; setDot(sessId,'ok'); updateConnBar('ok',s);
    term.write(`\x1b[32m✓ Connected!\x1b[0m\r\n`);
    // Bind SSH input here (not in makeTerminal)
    term.onData(data=>{ term.scrollToBottom(); try{window.roshi.sendInput(tabId,data);}catch(e){} });
    renderTabs();
    setTimeout(()=>{ try{fit.fit();window.roshi.resizeTerm(tabId,term.cols,term.rows);}catch(e){} },150);
  } else {
    tab.connected=false; setDot(sessId,'err'); updateConnBar('err',s);
    term.write(`\x1b[31m✕ Failed: ${result.error}\x1b[0m\r\n`);
    renderTabs();
  }
}

async function disconnectActive() {
  const t=activeT(); if(!t) return;
  if(t.isLocal) { try{await window.roshi.localStop(t.id);}catch(e){} }
  else { try{await window.roshi.disconnect(t.id);}catch(e){} }
  t.connected=false; t.term?.write('\r\n\x1b[33m── Disconnected ──\x1b[0m\r\n');
  setDot(t.sessId,'off'); renderTabs(); updateConnBar();
  if(monTabId===t.id) stopMonitor();
}
async function reconnectActive() {
  const t=activeT(); if(!t?.sessId) return;
  try{await window.roshi.disconnect(t.id);}catch(e){}
  t.connected=false;
  const s=getSess(t.sessId); if(!s) return;
  setDot(t.sessId,'ing'); updateConnBar('ing',s);
  t.term?.write('\r\n\x1b[36mReconnecting...\x1b[0m\r\n');
  let res;
  try{
    res=await window.roshi.connect({
      tabId:t.id,host:s.host,port:parseInt(s.port)||22,username:s.username,
      password:s.authType==='password'?s.password:undefined,
      privateKey:s.authType==='key'?s.privateKey:undefined,
      passphrase:s.passphrase||undefined,
    });
  }catch(e){res={ok:false,error:e.message};}
  if(res.ok){
    t.connected=true; setDot(t.sessId,'ok'); updateConnBar('ok',s);
    t.term?.write('\x1b[32m✓ Reconnected!\x1b[0m\r\n');
    t.term?.onData(data=>{ try{window.roshi.sendInput(t.id,data);}catch(e){} });
    setTimeout(()=>{ try{t.fit?.fit();window.roshi.resizeTerm(t.id,t.term.cols,t.term.rows);}catch(e){} },150);
  } else {
    setDot(t.sessId,'err'); updateConnBar('err',s);
    t.term?.write(`\x1b[31m✕ ${res.error}\x1b[0m\r\n`);
  }
  renderTabs();
}
function duplicateActive(){ const t=activeT(); if(t?.sessId) connectSession(t.sessId); else showToast('No session to duplicate'); }

function updateConnBar(state,sess) {
  const t=activeT(), s=sess||(t?.sessId?getSess(t.sessId):null);
  const bar=$('connBar');
  if(!t){bar.classList.add('hide');return;}
  bar.classList.remove('hide');
  const dot=$('cdot'),lbl=$('connLbl'),st=state||(t.connected?'ok':'off');
  dot.className='cdot '+st;
  if(st==='ok'){
    const shellLabels={powershell:'PowerShell',cmd:'CMD',bash:'Bash',cygwin:'Cygwin',gitbash:'Git Bash',pwsh:'PS Core',wslbash:'WSL Bash',cmd_fallback:'CMD'};
    if(t.isLocal) { lbl.textContent=`${shellLabels[t.shellPref]||'Terminal'} — Local`; lbl.style.color='#39ff6e'; }
    else { lbl.textContent=s?`${s.username}@${s.host}:${s.port||22}`:'Connected'; lbl.style.color='#39ff6e'; }
  }
  else if(st==='ing'){lbl.textContent=`Connecting to ${s?.host||''}...`;lbl.style.color='#ffa502';}
  else if(st==='err'){lbl.textContent='Connection failed';lbl.style.color='#ff4757';}
  else{lbl.textContent='Disconnected';lbl.style.color='var(--txt2)';}
}

function sendCmd(data){ const t=activeT(); if(t?.connected) window.roshi.sendInput(t.id,data); else showToast('Connect to an SSH session first'); }

// ── K8S / COLOR PANEL ──────────────────────────────────────────────────────
function toggleK8s(){
  k8sOpen=!k8sOpen; $('k8sPanel').classList.toggle('hide',!k8sOpen);
  if($('btnK8s')) $('btnK8s').classList.toggle('on',k8sOpen);
  if(k8sOpen) showView('term');
  setTimeout(()=>{ try{activeT()?.fit?.fit();}catch(e){} },280);
}
function toggleCP(){ cpOpen=!cpOpen; $('cpanel').classList.toggle('open',cpOpen); }

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// ── SYSTEM MONITOR (Windows Local + SSH Remote) ───────────────────────────
// ══════════════════════════════════════════════════════════════════════════

let monMode = 'local'; // 'local' or 'remote'

function updateMonitorView() {
  const hasRemote = tabs.some(t=>t.connected);
  // Mode buttons
  $('monModeLocal').classList.toggle('on', monMode==='local');
  $('monModeRemote').classList.toggle('on', monMode==='remote');
  // Show warning if remote selected but no session
  $('monNoSess').classList.toggle('hide', !(monMode==='remote' && !hasRemote));
  $('monBody').classList.toggle('hide', !monRunning);
}

function setMonMode(mode) {
  if (monRunning) stopMonitor();
  monMode = mode;
  updateMonitorView();
}

async function startMonitor() {
  if (monMode === 'remote') {
    const connected = tabs.find(t=>t.connected);
    if (!connected) { showToast('Connect to an SSH session first'); return; }
    monTabId = connected.id;
    const s = getSess(connected.sessId);
    $('monHost').textContent = s ? `🖥 ${s.username}@${s.host}` : '🖥 Remote';
  } else {
    monTabId = null;
    $('monHost').textContent = '🖥 This Computer';
  }
  monRunning = true;
  $('monStartBtn').classList.add('hide');
  $('monStopBtn').classList.remove('hide');
  $('monDot').className = 'mon-dot live';
  $('monStatusTxt').textContent = 'Live';
  $('monNoSess').classList.add('hide');
  $('monBody').classList.remove('hide');
  await fetchStats();
  monInterval = setInterval(fetchStats, 4000);
  $('monRefreshInfo').textContent = 'Refreshes every 4s';
}

function stopMonitor() {
  clearInterval(monInterval); monInterval=null; monRunning=false; monTabId=null;
  $('monStartBtn').classList.remove('hide');
  $('monStopBtn').classList.add('hide');
  $('monDot').className = 'mon-dot off';
  $('monStatusTxt').textContent = 'Stopped';
  $('monRefreshInfo').textContent = '';
  $('monBody').classList.add('hide');
}

async function fetchStats() {
  try {
    let data;
    if (monMode === 'local') {
      data = await window.roshi.monitorLocal();
    } else {
      if (!monTabId || !getTab(monTabId)?.connected) { stopMonitor(); return; }
      data = await fetchRemoteStats(monTabId);
    }
    if (!data?.ok) { showToast('Monitor error: '+(data?.error||'unknown')); return; }
    renderStats(data);
  } catch(e) {
    console.error('fetchStats error:', e);
    showToast('Monitor error: '+e.message);
  }
}

// Fetch stats from remote SSH Linux server
async function fetchRemoteStats(tabId) {
  const exec = cmd => window.roshi.exec(tabId, cmd);
  try {
    const [cpuOut, memOut, diskOut, uptimeOut, procOut, netOut, osOut] = await Promise.all([
      exec(`awk '/^cpu / {idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; printf "%.1f", (1-idle/total)*100}' /proc/stat`),
      exec(`free -m | awk '/^Mem:/{printf "%d %d %d", $2, $3, $4}'`),
      exec(`df -h / | awk 'NR==2{printf "%s %s %s %s", $2,$3,$4,$5}'`),
      exec(`uptime -p 2>/dev/null || uptime`),
      exec(`ps aux --sort=-%cpu | awk 'NR>1 && NR<=9 {printf "%s|%s|%s|%s|%s\n",$11,$2,$3,$4,$1}'`),
      exec(`cat /proc/net/dev | awk 'NR>2 && $1!="lo:" {gsub(":",""); printf "%s|%s|%s\n",$1,$2,$10}'`),
      exec(`cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -sr`),
    ]);
    const [mTotal,mUsed,mFree] = (memOut.output||'').split(' ').map(Number);
    const dParts = (diskOut.output||'').split(' ');
    const procs = (procOut.output||'').split('\n').filter(Boolean).map(l=>{
      const [name,pid,cpu,mem,user]=l.split('|');
      return {name:(name||'').split('/').pop().substring(0,28),pid:pid?.trim(),cpu:parseFloat(cpu)||0,mem:parseFloat(mem)||0,user:user?.trim()};
    });
    const nets = (netOut.output||'').split('\n').filter(Boolean).map(l=>{
      const [name,rx,tx]=l.split('|'); return {name:name?.trim(),rx:parseInt(rx)||0,tx:parseInt(tx)||0};
    });
    return {
      ok:true, platform:'linux',
      cpu:{pct:parseFloat(cpuOut.output)||0},
      mem:{usedMB:mUsed,totalMB:mTotal,pct:mTotal?Math.round((mUsed/mTotal)*100):0,freeMB:mFree},
      disk:{pct:parseInt(dParts[3])||0,usedGB:dParts[1],freeGB:dParts[2],totalGB:dParts[0]},
      uptime:(uptimeOut.output||'').trim().replace('up ','').split(',').slice(0,2).join(',').trim(),
      os:(osOut.output||'').trim(), gpu:'N/A', procs, nets,
    };
  } catch(e) { return {ok:false,error:e.message}; }
}

// Render stats data (works for both Windows and Linux)
function renderStats(d) {
  const fmtBytes = b=>{ const n=parseInt(b)||0; if(n>=1e9) return (n/1e9).toFixed(1)+' GB'; if(n>=1e6) return (n/1e6).toFixed(1)+' MB'; if(n>=1e3) return (n/1e3).toFixed(0)+' KB'; return n+' B'; };

  // ── CPU ──
  const cpu = d.cpu?.pct || 0;
  $('monCpuVal').innerHTML = `${cpu.toFixed(1)}<span>%</span>`;
  $('monCpuBar').style.width = Math.min(cpu,100)+'%';
  $('monCpuBar').style.background = cpu>80?'linear-gradient(90deg,#ffa502,#ff4757)':cpu>50?'linear-gradient(90deg,#ffa502,#ffcc00)':'linear-gradient(90deg,#5b8fff,#00e5ff)';
  $('monCpuSub').textContent = cpu>80?'🔥 High load':cpu>50?'⚠ Moderate':'✓ Normal';

  // ── Memory ──
  const m = d.mem || {};
  const toGB = mb => (mb/1024).toFixed(1);
  $('monMemVal').innerHTML = `${toGB(m.usedMB||0)}<span> / ${toGB(m.totalMB||0)} GB</span>`;
  $('monMemBar').style.width = (m.pct||0)+'%';
  $('monMemBar').style.background = (m.pct||0)>85?'linear-gradient(90deg,#ffa502,#ff4757)':'linear-gradient(90deg,#39ff6e,#00e5ff)';
  $('monMemSub').textContent = `${m.pct||0}% used · ${toGB(m.freeMB||0)} GB free`;

  // ── Disk ──
  const dk = d.disk || {};
  $('monDskVal').innerHTML = `${dk.pct||0}<span>%</span>`;
  $('monDskBar').style.width = (dk.pct||0)+'%';
  $('monDskBar').style.background = (dk.pct||0)>85?'linear-gradient(90deg,#ffa502,#ff4757)':(dk.pct||0)>60?'linear-gradient(90deg,#ffa502,#ffcc00)':'linear-gradient(90deg,#ffa502,#39ff6e)';
  $('monDskSub').textContent = `Used: ${dk.usedGB||'—'} · Free: ${dk.freeGB||'—'} · Total: ${dk.totalGB||'—'}`;

  // ── Uptime / OS / GPU ──
  $('monUptime').textContent = d.uptime || '—';
  $('monOsInfo').textContent = d.os || '—';
  const gpuEl = $('monGpu');
  if (gpuEl) gpuEl.textContent = d.gpu && d.gpu !== 'N/A' ? d.gpu : '';

  // ── Processes ──
  const tbody = $('monProcs');
  tbody.innerHTML = (d.procs||[]).map(p=>{
    const color = p.cpu>50?'var(--red)':p.cpu>20?'var(--yel)':'var(--txt2)';
    const memDisplay = d.platform==='windows' ? p.mem.toFixed(0)+' MB' : p.mem.toFixed(1)+'%';
    return `<tr>
      <td title="${esc(p.name)}">${esc((p.name||'').substring(0,26))}</td>
      <td>${esc(p.pid||'')}</td>
      <td style="color:${color};font-weight:700">${p.cpu.toFixed(1)}${d.platform==='windows'?'s':'%'}</td>
      <td>${memDisplay}</td>
      <td>${esc(p.user||'')}</td></tr>`;
  }).join('') || '<tr><td colspan="5" style="color:var(--txt3);text-align:center;padding:12px">No data yet</td></tr>';

  // ── Network ──
  $('monNet').innerHTML = (d.nets||[]).filter(n=>n.name).map(n=>`
    <div class="mon-net-row">
      <span class="mon-net-lbl">📡 ${esc(n.name)}</span>
      <span class="mon-net-val">↓ ${fmtBytes(n.rx)} &nbsp;↑ ${fmtBytes(n.tx)}</span>
    </div>`).join('') || '<span style="color:var(--txt3);font-size:12px;padding:8px">No network adapters found</span>';
}

// ── MODAL ──────────────────────────────────────────────────────────────────
function openModal(sessId) {
  editSessId=sessId; keyContent=null;
  const s=sessId?getSess(sessId):null;
  $('mTitle').textContent=s?'Edit Session':'New SSH Session';
  $('fLabel').value=s?.label||''; $('fHost').value=s?.host||'';
  $('fPort').value=s?.port||22; $('fUser').value=s?.username||'';
  $('fPwd').value=s?.password||''; $('fKeyPath').value=s?.keyPath||'';
  $('fPass').value=s?.passphrase||'';
  $('testRes').className='test-res hide';
  selAuth=s?.authType||'password';
  $$('.at').forEach(t=>t.classList.toggle('on',t.dataset.auth===selAuth));
  $('apPwd').classList.toggle('hide',selAuth!=='password');
  $('apKey').classList.toggle('hide',selAuth!=='key');
  selColor=s?.color||'#39ff6e';
  $$('.ctag').forEach(t=>t.classList.toggle('on',t.dataset.c===selColor));
  $('btnDel').classList.toggle('hide',!s);
  $('modalOverlay').classList.remove('hide');
  setTimeout(()=>$('fHost').focus(),100);
}
function closeModal(){ $('modalOverlay').classList.add('hide'); editSessId=null; keyContent=null; }

async function saveAndConnect() {
  const host=$('fHost').value.trim(), user=$('fUser').value.trim();
  if(!host){showToast('Host / IP is required');return;}
  if(!user){showToast('Username is required');return;}
  const s={
    id:editSessId||('s'+Date.now()),
    label:$('fLabel').value.trim()||host,
    host, port:parseInt($('fPort').value)||22,
    username:user, authType:selAuth,
    password:$('fPwd').value,
    privateKey:keyContent||getSess(editSessId)?.privateKey||null,
    keyPath:$('fKeyPath').value,
    passphrase:$('fPass').value,
    color:selColor,
  };
  if(editSessId){ const i=sessions.findIndex(x=>x.id===editSessId); if(i!==-1) sessions[i]=s; else sessions.push(s); }
  else sessions.push(s);
  await saveSess(); renderSessList(); closeModal(); connectSession(s.id);
}

async function testConn() {
  const host=$('fHost').value.trim(), user=$('fUser').value.trim();
  if(!host||!user){showToast('Fill Host and Username first');return;}
  const res=$('testRes'); res.className='test-res'; res.textContent='⟳ Testing...';
  const testId='test-'+Date.now();
  let result;
  try{
    result=await window.roshi.connect({
      tabId:testId,host,port:parseInt($('fPort').value)||22,username:user,
      password:selAuth==='password'?$('fPwd').value:undefined,
      privateKey:selAuth==='key'?(keyContent||getSess(editSessId)?.privateKey):undefined,
      passphrase:$('fPass').value||undefined,
    });
  }catch(e){result={ok:false,error:e.message};}
  try{await window.roshi.disconnect(testId);}catch(e){}
  if(result.ok){res.className='test-res ok';res.textContent='✓ Connection successful!';}
  else{res.className='test-res err';res.textContent='✕ '+result.error;}
}

async function deleteSession() {
  if(!editSessId) return;
  const confirmed = await showConfirm('Delete this session?', 'This cannot be undone.');
  if(!confirmed) return;
  tabs.filter(t=>t.sessId===editSessId).forEach(t=>closeTab(t.id));
  sessions=sessions.filter(s=>s.id!==editSessId);
  await saveSess(); renderSessList(); closeModal(); showToast('Session deleted');
}

async function browseKey() {
  const r=await window.roshi.openKeyFile(); if(!r) return;
  if(r.error){showToast('Error: '+r.error);return;}
  $('fKeyPath').value=r.filePath; keyContent=r.content; showToast('Key loaded');
}

// ── TOAST ──────────────────────────────────────────────────────────────────
// ── Home screen boot sequence ─────────────────────────────────────────────────
function runBootSequence() {
  const el = $('hboot');
  if (!el) return;
  el.innerHTML = '';
  const lines = [
    '> Initializing SSH Manager...',
    '> Loading sessions...',
    '> Connected.',
  ];
  let i = 0;
  function showLine() {
    if (i >= lines.length) {
      // Remove cursor after done
      const cur = el.querySelector('.hcursor');
      if (cur) setTimeout(() => cur.remove(), 1500);
      return;
    }
    const div = document.createElement('div');
    div.className = 'hboot-line';
    div.textContent = lines[i];
    // Add blinking cursor to last line
    if (i === lines.length - 1) {
      const cur = document.createElement('span');
      cur.className = 'hcursor';
      cur.style.marginLeft = '4px';
      div.appendChild(cur);
    }
    el.appendChild(div);
    setTimeout(() => div.classList.add('show'), 30);
    i++;
    setTimeout(showLine, i === 1 ? 600 : 400);
  }
  setTimeout(showLine, 300);
}

function showToast(msg){
  clearTimeout(toastTmr);
  $('toastMsg').textContent=msg; $('toast').classList.remove('hide');
  toastTmr=setTimeout(()=>$('toast').classList.add('hide'),2800);
}


// ── DETECT INSTALLED SHELLS ────────────────────────────────────────────────
async function detectShells() {
  let shells = [];
  try { shells = await window.roshi.localShells(); } catch(e) {
    console.warn('detectShells failed:', e);
    return;
  }
  if (!shells || !shells.length) return;

  const selIds = ['homeShellPick', 'tbShellSel'];
  // PowerShell only — filter out CMD, Cygwin, Git Bash, WSL
  // Sort: gitbash first, then powershell, then pwsh
  const filteredShells = shells.filter(s => s.id === 'gitbash');
  for (const selId of selIds) {
    const sel = $(selId);
    if (!sel) continue;
    sel.innerHTML = '';
    filteredShells.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      // Select gitbash if available, otherwise select first available
      if (s.id === 'gitbash') opt.selected = true;
      else if (i === 0 && !filteredShells.find(x => x.id === 'gitbash')) opt.selected = true;
      sel.appendChild(opt);
    });
  }
}


// ══════════════════════════════════════════════════════════════
// KUBERNETES DASHBOARD ENGINE
// ══════════════════════════════════════════════════════════════

let k8sInterval = null, k8sAutoOn = true, k8sCurrentTab = 'overview';

function getK8sTabId() {
  const conn = tabs.find(t => t.connected);
  return conn ? conn.id : null;
}

function k8sExec(cmd) {
  const tabId = getK8sTabId();
  if (!tabId) return Promise.resolve({ ok: false, error: 'No SSH session' });
  return window.roshi.exec(tabId, cmd);
}

async function initK8sDash() {
  const tabId = getK8sTabId();
  const noConn = $('k8sNoConn'), body = $('k8sBody');
  if (!tabId) {
    noConn?.classList.remove('hide');
    body?.classList.add('hide');
    return;
  }
  noConn?.classList.add('hide');
  body?.classList.remove('hide');

  // Bind tabs
  $$('[data-k8stab]').forEach(t => t.onclick = () => {
    $$('[data-k8stab]').forEach(x => x.classList.remove('on')); t.classList.add('on');
    k8sCurrentTab = t.dataset.k8stab;
    $$('[id^="k8stab-"]').forEach(p => p.classList.add('hide'));
    $('k8stab-' + k8sCurrentTab)?.classList.remove('hide');
    k8sRefresh();
  });

  // Namespace filter
  $('k8sNs').onchange = () => k8sRefresh();

  // Buttons
  $('k8sRefreshBtn').onclick = () => k8sRefresh();
  $('k8sAutoRefresh').onclick = () => {
    k8sAutoOn = !k8sAutoOn;
    $('k8sAutoRefresh').classList.toggle('on', k8sAutoOn);
    if (k8sAutoOn) startK8sAutoRefresh();
    else { clearInterval(k8sInterval); k8sInterval = null; }
  };

  // Get context & namespaces
  k8sExec('kubectl config current-context 2>/dev/null').then(r => {
    if (r.ok) $('k8sCtx').textContent = '⎈ ' + r.output.trim();
  });
  k8sExec('kubectl get namespaces --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null').then(r => {
    if (r.ok) {
      const sel = $('k8sNs');
      sel.innerHTML = '<option value="all">All Namespaces</option>';
      r.output.trim().split(/\s+/).forEach(ns => {
        const o = document.createElement('option');
        o.value = ns; o.textContent = ns; sel.appendChild(o);
      });
    }
  });

  await k8sRefresh();
  if (k8sAutoOn) startK8sAutoRefresh();
}

function startK8sAutoRefresh() {
  clearInterval(k8sInterval);
  k8sInterval = setInterval(k8sRefresh, 10000);
}

async function k8sRefresh() {
  const ns = $('k8sNs')?.value || 'all';
  const nsFlag = ns === 'all' ? '-A' : `-n ${ns}`;
  const now = new Date().toLocaleTimeString();
  if ($('k8sRefreshTime')) $('k8sRefreshTime').textContent = 'Updated ' + now;

  if (k8sCurrentTab === 'overview') await k8sLoadOverview(nsFlag);
  else if (k8sCurrentTab === 'nodes') await k8sLoadNodes();
  else if (k8sCurrentTab === 'pods') await k8sLoadPods(nsFlag);
  else if (k8sCurrentTab === 'deployments') await k8sLoadDeployments(nsFlag);
  else if (k8sCurrentTab === 'services') await k8sLoadServices(nsFlag);
  else if (k8sCurrentTab === 'events') await k8sLoadEvents(nsFlag);
}

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
async function k8sLoadOverview(nsFlag) {
  const [nodes, pods, deps, svcs, nss, events, topNodes] = await Promise.all([
    k8sExec('kubectl get nodes --no-headers 2>/dev/null'),
    k8sExec(`kubectl get pods ${nsFlag} --no-headers 2>/dev/null`),
    k8sExec(`kubectl get deployments ${nsFlag} --no-headers 2>/dev/null`),
    k8sExec('kubectl get svc -A --no-headers 2>/dev/null'),
    k8sExec('kubectl get namespaces --no-headers 2>/dev/null'),
    k8sExec('kubectl get events -A --sort-by=.lastTimestamp --no-headers 2>/dev/null | tail -8'),
    k8sExec('kubectl top nodes --no-headers 2>/dev/null'),
  ]);

  // Nodes
  if (nodes.ok) {
    const lines = nodes.output.trim().split('\n').filter(Boolean);
    const ready = lines.filter(l => l.includes(' Ready ')).length;
    $('k8sNodeCount').textContent = lines.length;
    $('k8sNodeReady').textContent = ready + ' ready';
  }

  // Pods
  if (pods.ok) {
    const lines = pods.output.trim().split('\n').filter(Boolean);
    const running = lines.filter(l => l.includes('Running')).length;
    const failed = lines.filter(l => l.match(/Failed|Error|CrashLoop/)).length;
    $('k8sPodCount').textContent = lines.length;
    $('k8sPodRunning').textContent = running + ' running';
    $('k8sFailedCount').textContent = failed;
    $('k8sFailedCount').style.color = failed > 0 ? 'var(--red)' : 'var(--green)';
  }

  // Deployments
  if (deps.ok) {
    const lines = deps.output.trim().split('\n').filter(Boolean);
    const ready = lines.filter(l => {
      const parts = l.trim().split(/\s+/);
      return parts[1] && parts[1].split('/')[0] === parts[1].split('/')[1];
    }).length;
    $('k8sDepCount').textContent = lines.length;
    $('k8sDepReady').textContent = ready + ' ready';
  }

  if (svcs.ok) $('k8sSvcCount').textContent = svcs.output.trim().split('\n').filter(Boolean).length;
  if (nss.ok) $('k8sNsCount').textContent = nss.output.trim().split('\n').filter(Boolean).length;

  // Node metrics bars
  const metricsEl = $('k8sNodeMetrics');
  if (topNodes.ok && topNodes.output.trim()) {
    const lines = topNodes.output.trim().split('\n').filter(Boolean);
    metricsEl.innerHTML = lines.map(l => {
      const p = l.trim().split(/\s+/);
      const name = p[0], cpu = p[1]||'?', mem = p[3]||'?';
      const cpuPct = parseInt(p[2]) || 0, memPct = parseInt(p[4]) || 0;
      const cpuColor = cpuPct > 80 ? '#ff4757' : cpuPct > 50 ? '#ffa502' : '#39ff6e';
      const memColor = memPct > 85 ? '#ff4757' : '#5b8fff';
      return `<div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:var(--txt);margin-bottom:4px">🖥 ${name}</div>
        <div class="k8sd-node-bar-wrap">
          <span class="k8sd-node-bar-lbl">CPU</span>
          <div class="k8sd-node-bar-bg"><div class="k8sd-node-bar-fill" style="width:${cpuPct}%;background:${cpuColor}"></div></div>
          <span class="k8sd-node-bar-val">${cpu} (${cpuPct}%)</span>
        </div>
        <div class="k8sd-node-bar-wrap">
          <span class="k8sd-node-bar-lbl">Memory</span>
          <div class="k8sd-node-bar-bg"><div class="k8sd-node-bar-fill" style="width:${memPct}%;background:${memColor}"></div></div>
          <span class="k8sd-node-bar-val">${mem} (${memPct}%)</span>
        </div>
      </div>`;
    }).join('');
  } else {
    metricsEl.innerHTML = '<div class="k8sd-empty">⚠ metrics-server not available — run: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml</div>';
  }

  // Recent events
  const evEl = $('k8sRecentEvents');
  if (events.ok && events.output.trim()) {
    const lines = events.output.trim().split('\n').filter(Boolean);
    evEl.innerHTML = `<table class="k8sd-table"><thead><tr><th>Type</th><th>Reason</th><th>Object</th><th>Message</th></tr></thead><tbody>` +
      lines.map(l => {
        const p = l.trim().split(/\s+/);
        const type = p[0]||'', reason = p[1]||'', obj = (p[3]||''), msg = p.slice(6).join(' ').substring(0,80);
        const color = type==='Warning' ? 'var(--red)' : type==='Normal' ? 'var(--green)' : 'var(--txt2)';
        return `<tr><td style="color:${color}">${type}</td><td>${reason}</td><td>${obj}</td><td>${msg}</td></tr>`;
      }).join('') + '</tbody></table>';
  } else {
    evEl.innerHTML = '<div class="k8sd-empty">No recent events</div>';
  }
}

// ── CHART DATA HISTORY ───────────────────────────────────────────────────────
const k8sChartHistory = {};  // { nodeName: { cpu: [], mem: [], labels: [] } }
const K8S_MAX_POINTS = 20;
let cpuChart = null, memChart = null;
const NODE_COLORS = ['#00e5ff','#39ff6e','#ffa502','#ff4757','#bc8cff','#ff6ec7'];

function getOrCreateHistory(name) {
  if (!k8sChartHistory[name]) k8sChartHistory[name] = { cpu: [], mem: [], labels: [] };
  return k8sChartHistory[name];
}

function pushHistory(name, cpu, mem) {
  const h = getOrCreateHistory(name);
  const t = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  h.labels.push(t); h.cpu.push(cpu); h.mem.push(mem);
  if (h.labels.length > K8S_MAX_POINTS) { h.labels.shift(); h.cpu.shift(); h.mem.shift(); }
}

function initCharts(nodeNames) {
  const cpuCanvas = $('chartCpuLine');
  const memCanvas = $('chartMemLine');
  if (!cpuCanvas || !memCanvas || typeof Chart === 'undefined') return;

  if (cpuChart) { cpuChart.destroy(); cpuChart = null; }
  if (memChart) { memChart.destroy(); memChart = null; }

  const chartOpts = (title, max) => ({
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#888', font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#555', font: { size: 9 }, maxTicksLimit: 6 }, grid: { color: '#ffffff0a' } },
        y: { min: 0, max: max, ticks: { color: '#555', font: { size: 10 }, callback: v => v + '%' }, grid: { color: '#ffffff0a' } }
      }
    }
  });

  cpuChart = new Chart(cpuCanvas, chartOpts('CPU %', 100));
  memChart = new Chart(memCanvas, chartOpts('Memory %', 100));

  nodeNames.forEach((name, i) => {
    const color = NODE_COLORS[i % NODE_COLORS.length];
    const h = getOrCreateHistory(name);
    cpuChart.data.datasets.push({ label: name, data: [...h.cpu], borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 2, tension: 0.4, fill: true });
    memChart.data.datasets.push({ label: name, data: [...h.mem], borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 2, tension: 0.4, fill: true });
  });
  // Sync labels from first node
  const firstNode = nodeNames[0];
  if (firstNode) {
    cpuChart.data.labels = [...(k8sChartHistory[firstNode]?.labels || [])];
    memChart.data.labels = [...(k8sChartHistory[firstNode]?.labels || [])];
  }
  cpuChart.update(); memChart.update();
}

function updateCharts(nodeNames) {
  if (!cpuChart || !memChart) { initCharts(nodeNames); return; }
  const firstNode = nodeNames[0];
  if (firstNode) {
    cpuChart.data.labels = [...(k8sChartHistory[firstNode]?.labels || [])];
    memChart.data.labels = [...(k8sChartHistory[firstNode]?.labels || [])];
  }
  nodeNames.forEach((name, i) => {
    const h = k8sChartHistory[name];
    if (!h) return;
    if (cpuChart.data.datasets[i]) cpuChart.data.datasets[i].data = [...h.cpu];
    if (memChart.data.datasets[i]) memChart.data.datasets[i].data = [...h.mem];
  });
  cpuChart.update('none');
  memChart.update('none');
}

// ── NODES ────────────────────────────────────────────────────────────────────
async function k8sLoadNodes() {
  const [nodes, top] = await Promise.all([
    k8sExec('kubectl get nodes -o wide --no-headers 2>/dev/null'),
    k8sExec('kubectl top nodes --no-headers 2>/dev/null'),
  ]);
  const topMap = {};
  if (top.ok) top.output.trim().split('\n').filter(Boolean).forEach(l => {
    const p = l.trim().split(/\s+/); topMap[p[0]] = { cpu: p[1], cpuPct: p[2], mem: p[3], memPct: p[4] };
  });

  const tbody = $('k8sNodesTbl');
  if (!nodes.ok || !nodes.output.trim()) { tbody.innerHTML = '<tr><td colspan="8" class="k8sd-empty">No nodes found</td></tr>'; return; }

  const lines = nodes.output.trim().split('\n').filter(Boolean);
  const nodeNames = [];

  // Update chart history
  if (top.ok && top.output.trim()) {
    top.output.trim().split('\n').filter(Boolean).forEach(l => {
      const p = l.trim().split(/\s+/);
      const name = p[0];
      nodeNames.push(name);
      const cpuPct = parseInt(p[2]) || 0;
      const memPct = parseInt(p[4]) || 0;
      pushHistory(name, cpuPct, memPct);
    });
    if (nodeNames.length) updateCharts(nodeNames);
  }

  // Node cards
  const cardsEl = $('k8sNodeCards');
  if (cardsEl) {
    cardsEl.innerHTML = lines.map((l, i) => {
      const p = l.trim().split(/\s+/);
      const name=p[0], status=p[1], roles=p[2];
      const t = topMap[name] || {};
      const cpuPct = parseInt(t.cpuPct) || 0;
      const memPct = parseInt(t.memPct) || 0;
      const color = NODE_COLORS[i % NODE_COLORS.length];
      const statusColor = status==='Ready' ? '#39ff6e' : '#ff4757';
      return `<div style="background:var(--bg3);border:1px solid ${color}33;border-top:3px solid ${color};border-radius:8px;padding:12px">
        <div style="font-size:12px;font-weight:800;color:${color};margin-bottom:6px">🖥 ${name}</div>
        <div style="font-size:10px;color:${statusColor};margin-bottom:8px">● ${status} · ${roles}</div>
        <div style="font-size:10px;color:var(--txt3);margin-bottom:3px">CPU: <span style="color:${cpuPct>80?'#ff4757':cpuPct>50?'#ffa502':color};font-weight:700">${t.cpu||'—'} (${t.cpuPct||'?'})</span></div>
        <div style="font-size:10px;color:var(--txt3)">MEM: <span style="color:#5b8fff;font-weight:700">${t.mem||'—'} (${t.memPct||'?'})</span></div>
        <div style="margin-top:8px;height:4px;background:var(--bg4);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${cpuPct}%;background:${color};border-radius:2px;transition:width .6s"></div>
        </div>
      </div>`;
    }).join('');
  }

  // Table
  tbody.innerHTML = lines.map(l => {
    const p = l.trim().split(/\s+/);
    const name=p[0], status=p[1], roles=p[2], age=p[3], ver=p[4], os=p[6]||'—';
    const t = topMap[name] || {};
    const badge = status === 'Ready' ? 'ready' : 'notready';
    return `<tr>
      <td>${name}</td>
      <td><span class="k8s-badge ${badge}">${status}</span></td>
      <td>${roles}</td><td>${age}</td><td>${ver}</td><td>${os}</td>
      <td>${t.cpu||'—'} <span style="color:var(--txt3)">(${t.cpuPct||'?'})</span></td>
      <td>${t.mem||'—'} <span style="color:var(--txt3)">(${t.memPct||'?'})</span></td>
    </tr>`;
  }).join('');
}

// ── PODS ─────────────────────────────────────────────────────────────────────
async function k8sLoadPods(nsFlag) {
  const r = await k8sExec(`kubectl get pods ${nsFlag} -o wide --no-headers 2>/dev/null`);
  const tbody = $('k8sPodsTbl');
  if (!r.ok || !r.output.trim()) { tbody.innerHTML = '<tr><td colspan="7" class="k8sd-empty">No pods found</td></tr>'; return; }
  const lines = r.output.trim().split('\n').filter(Boolean);
  tbody.innerHTML = lines.map(l => {
    const p = l.trim().split(/\s+/);
    const isNsFlag = nsFlag === '-A';
    let name, ns, ready, status, restarts, age, node;
    if (isNsFlag) { [ns, name, ready, status, restarts, age, , node] = p; }
    else { [name, ready, status, restarts, age, , node] = p; ns = nsFlag.replace('-n ',''); }
    const badge = status==='Running'?'running':status==='Pending'?'pending':status==='Succeeded'?'ready':'failed';
    const restartColor = parseInt(restarts) > 5 ? 'color:var(--red)' : '';
    return `<tr>
      <td>${name||'—'}</td><td>${ns||'—'}</td>
      <td><span class="k8s-badge ${badge}">${status||'—'}</span></td>
      <td>${ready||'—'}</td>
      <td style="${restartColor}">${restarts||'0'}</td>
      <td>${age||'—'}</td><td>${node||'—'}</td>
    </tr>`;
  }).join('');
}

// ── DEPLOYMENTS ───────────────────────────────────────────────────────────────
async function k8sLoadDeployments(nsFlag) {
  const r = await k8sExec(`kubectl get deployments ${nsFlag} --no-headers 2>/dev/null`);
  const tbody = $('k8sDepTbl');
  if (!r.ok || !r.output.trim()) { tbody.innerHTML = '<tr><td colspan="6" class="k8sd-empty">No deployments found</td></tr>'; return; }
  const lines = r.output.trim().split('\n').filter(Boolean);
  tbody.innerHTML = lines.map(l => {
    const p = l.trim().split(/\s+/);
    const isAll = nsFlag === '-A';
    let ns='—', name, ready, upToDate, available, age;
    if (isAll) { [ns, name, ready, upToDate, available, age] = p; }
    else { [name, ready, upToDate, available, age] = p; }
    const [r1,r2] = (ready||'0/0').split('/');
    const ok = r1 === r2;
    return `<tr>
      <td>${name||'—'}</td><td>${ns}</td>
      <td style="color:${ok?'var(--green)':'var(--yel)'}">${ready||'—'}</td>
      <td>${upToDate||'—'}</td><td>${available||'—'}</td><td>${age||'—'}</td>
    </tr>`;
  }).join('');
}

// ── SERVICES ──────────────────────────────────────────────────────────────────
async function k8sLoadServices(nsFlag) {
  const r = await k8sExec(`kubectl get svc ${nsFlag} --no-headers 2>/dev/null`);
  const tbody = $('k8sSvcTbl');
  if (!r.ok || !r.output.trim()) { tbody.innerHTML = '<tr><td colspan="7" class="k8sd-empty">No services found</td></tr>'; return; }
  const lines = r.output.trim().split('\n').filter(Boolean);
  tbody.innerHTML = lines.map(l => {
    const p = l.trim().split(/\s+/);
    const isAll = nsFlag === '-A';
    let ns='—', name, type, clusterIp, externalIp, ports, age;
    if (isAll) { [ns, name, type, clusterIp, externalIp, ports, age] = p; }
    else { [name, type, clusterIp, externalIp, ports, age] = p; }
    const typeColor = type==='LoadBalancer'?'var(--cyan)':type==='NodePort'?'var(--yel)':'var(--txt2)';
    return `<tr>
      <td>${name||'—'}</td><td>${ns}</td>
      <td style="color:${typeColor}">${type||'—'}</td>
      <td>${clusterIp||'—'}</td>
      <td style="color:${externalIp&&externalIp!=='<none>'?'var(--green)':'var(--txt3)'}">${externalIp||'—'}</td>
      <td>${ports||'—'}</td><td>${age||'—'}</td>
    </tr>`;
  }).join('');
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
async function k8sLoadEvents(nsFlag) {
  const r = await k8sExec(`kubectl get events ${nsFlag} --sort-by=.lastTimestamp --no-headers 2>/dev/null | tail -50`);
  const tbody = $('k8sEventsTbl');
  if (!r.ok || !r.output.trim()) { tbody.innerHTML = '<tr><td colspan="6" class="k8sd-empty">No events</td></tr>'; return; }
  const lines = r.output.trim().split('\n').filter(Boolean).reverse();
  tbody.innerHTML = lines.map(l => {
    const p = l.trim().split(/\s+/);
    const isAll = nsFlag === '-A';
    let ns='—', age, type, reason, obj, msg;
    if (isAll) { [ns, age, type, reason, obj, ...rest] = p; msg = rest.join(' '); }
    else { [age, type, reason, obj, ...rest] = p; msg = rest.join(' '); }
    const color = type==='Warning'?'var(--red)':type==='Normal'?'var(--green)':'var(--txt2)';
    return `<tr>
      <td style="color:${color}">${type||'—'}</td>
      <td>${reason||'—'}</td>
      <td>${obj||'—'}</td>
      <td>${ns}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${(msg||'').replace(/"/g,"'")}">${(msg||'—').substring(0,80)}</td>
      <td>${age||'—'}</td>
    </tr>`;
  }).join('');
}

// Stop K8s refresh when leaving the view
const _origShowView = showView;
// Patch showView to stop k8s refresh


// ── Custom confirm dialog ────────────────────────────────────────────────────
function showConfirm(title, subtitle) {
  return new Promise(function(resolve) {
    var existing = document.getElementById('confirmOverlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'confirmOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:#00000099;z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

    var sub = subtitle ? '<div style="font-size:12px;color:var(--txt3);margin-top:4px">'+subtitle+'</div>' : '';

    overlay.innerHTML =
      '<div style="background:var(--bg);border:1px solid var(--bd2);border-radius:10px;width:360px;overflow:hidden;box-shadow:0 0 0 1px var(--bd),0 20px 60px #00000090;">' +
        '<div style="padding:14px 18px;border-bottom:2px solid var(--red);background:var(--bg2);display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:16px">⚠</span>' +
          '<span style="font-size:13px;font-weight:800;color:var(--red)">Confirm Delete</span>' +
        '</div>' +
        '<div style="padding:20px 18px">' +
          '<div style="font-size:14px;font-weight:700;color:var(--txt)">' + title + '</div>' +
          sub +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--bd);background:var(--bg2)">' +
          '<button id="confirmNo" style="background:transparent;border:1px solid var(--bd2);color:var(--txt2);padding:8px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">Cancel</button>' +
          '<button id="confirmYes" style="background:var(--red);border:1px solid var(--red);color:#fff;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">🗑 Delete</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    function cleanup(result) { overlay.remove(); resolve(result); }
    overlay.querySelector('#confirmYes').onclick = function() { cleanup(true); };
    overlay.querySelector('#confirmNo').onclick  = function() { cleanup(false); };
    overlay.onclick = function(e) { if (e.target === overlay) cleanup(false); };
    function onKey(e) {
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); cleanup(true); }
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(false); }
    }
    document.addEventListener('keydown', onKey);
  });
}

// ── Terminal Transparency Toggle ─────────────────────────────────────────────
function applyTermTransparency(enabled, save) {
  settings.termTransparent = enabled;
  const termWrap = $('term-wrap');
  const btn = $('btnTermTransp');

  if (enabled) {
    // Transparent: desktop shows through terminal area
    document.body.classList.add('term-transparent');
    tabs.forEach(t => { if (t.term) t.term.options.theme = {...xtermTheme(), background:'transparent'}; });
    const darkness = (100 - (settings.opacity || 100)) / 100;
    if (termWrap) termWrap.style.setProperty('--term-overlay', `rgba(0,0,0,${darkness.toFixed(2)})`);
    if (btn) { btn.textContent = '⬛ Disable'; btn.classList.add('on'); }
  } else {
    // Opaque: use theme background
    document.body.classList.remove('term-transparent');
    tabs.forEach(t => { if (t.term) t.term.options.theme = xtermTheme(); });
    if (termWrap) termWrap.style.setProperty('--term-overlay', 'rgba(0,0,0,0)');
    if (btn) { btn.textContent = '⬜ Enable'; btn.classList.remove('on'); }
  }
  if (save) saveCfg();
}

boot();
