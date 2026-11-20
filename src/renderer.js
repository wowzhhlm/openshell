/* OpenShell 渲染层：无 Node 权限，仅通过 window.openshell 白名单 API 与本地服务通信 */
const api = window.openshell;
const Fmt = window.SessionFormat;
const Terminal = window.Terminal;
const _FitAddonGlobal = window.FitAddon;
const FitAddon = (_FitAddonGlobal && _FitAddonGlobal.FitAddon) || _FitAddonGlobal;

const SESSIONS_KEY = 'openshell.sessions.v1';
const PREFS_KEY = 'openshell.prefs.v1';
const FW_KEY = 'openshell.forwarding.v1';

const $ = (id) => document.getElementById(id);
const tabs = new Map();
let activeTabId = null;
let tabSeq = 0;
let editingSessionId = null;
let selectedSftpRow = null;
let scriptRunning = false;
let selectedSessionId = null;
let batchImportFiles = [];
let outputPaths = { root: 'D:\\openshell', exports: 'D:\\openshell\\导出', downloads: 'D:\\openshell\\下载', reports: 'D:\\openshell\\报告' };

function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function status(text) { $('status-left').textContent = text; }
function posixDirname(p) {
  const parts = String(p || '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}
function posixJoin(base, name) {
  return String(base || '').replace(/\/$/, '') + '/' + String(name);
}
function formatBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + units[i];
}

/* ---------------- 会话管理 ---------------- */
function getSessions() { return loadJSON(SESSIONS_KEY, []); }
function saveSessions(list) { saveJSON(SESSIONS_KEY, list); renderSessions(); }
function renderSessions() {
  const tree = $('session-tree');
  tree.textContent = '';
  const query = $('session-filter').value.trim().toLowerCase();
  const groups = new Map();
  getSessions().forEach((s) => {
    if (query && !`${s.name} ${s.host} ${s.user} ${s.group}`.toLowerCase().includes(query)) return;
    const key = s.group || '默认分组';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  if (groups.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '12px';
    empty.textContent = '暂无会话';
    tree.appendChild(empty);
    return;
  }
  groups.forEach((items, group) => {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = group;
    tree.appendChild(title);
    items.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'session-item' + (selectedSessionId === s.id ? ' active' : '');
      row.dataset.id = s.id;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.protocol = s.protocol || 'ssh';
      const meta = document.createElement('span');
      meta.className = 'meta';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (s.name || s.host) + ' ';
      const badge = document.createElement('span');
      badge.className = 'proto-badge';
      badge.textContent = String(s.protocol || 'ssh').toUpperCase();
      name.appendChild(badge);
      const host = document.createElement('span');
      host.className = 'host';
      host.textContent = `${s.user ? s.user + '@' : ''}${s.host}:${s.port}`;
      meta.append(name, host);
      const ops = document.createElement('span');
      ops.className = 'ops';
      const connectBtn = document.createElement('button');
      connectBtn.title = '连接';
      connectBtn.textContent = '连接';
      connectBtn.onclick = (e) => { e.stopPropagation(); connectSession(s); };
      const editBtn = document.createElement('button');
      editBtn.title = '编辑';
      editBtn.textContent = '✎';
      editBtn.onclick = (e) => { e.stopPropagation(); openSessionModal(s.id); };
      ops.append(connectBtn, editBtn);
      row.append(dot, meta, ops);
      row.onclick = () => { selectedSessionId = s.id; renderSessions(); };
      row.ondblclick = () => connectSession(s);
      tree.appendChild(row);
    });
  });
}
function openSessionModal(id = null) {
  editingSessionId = id;
  const s = id ? getSessions().find((x) => x.id === id) : null;
  $('session-modal-title').textContent = s ? '编辑会话' : '新建会话';
  $('f-name').value = s?.name || '';
  $('f-group').value = s?.group || '';
  $('f-host').value = s?.host || '';
  $('f-port').value = s?.port || 22;
  $('f-user').value = s?.user || '';
  $('f-protocol').value = Fmt.normalizeProtocol(s?.protocol);
  $('f-auth').value = s?.auth || 'password';
  $('f-password').value = '';
  $('f-keyfile').value = s?.keyfile || '';
  $('f-passphrase').value = '';
  $('cred-hint').textContent = s ? '凭据已加密保存，留空表示不修改。' : '凭据将加密保存到本机，不写入会话文件。';
  $('btn-session-delete').classList.toggle('hidden', !s);
  toggleProtocolFields();
  $('session-modal').classList.remove('hidden');
}
function toggleAuthFields() {
  const p = $('f-protocol') ? $('f-protocol').value : 'ssh';
  if (p === 'telnet' || p === 'raw') return;
  const isKey = $('f-auth').value === 'privatekey';
  $('lbl-password').classList.toggle('hidden', isKey);
  $('lbl-key').classList.toggle('hidden', !isKey);
}
function toggleProtocolFields() {
  const p = $('f-protocol').value;
  const isTunnel = ['telnet', 'rlogin', 'raw'].includes(p);
  const noAuth = ['raw', 'local', 'serial', 'rdp'].includes(p);
  $('lbl-user').classList.toggle('hidden', noAuth);
  $('lbl-auth').classList.toggle('hidden', isTunnel || noAuth);
  $('lbl-key').classList.toggle('hidden', isTunnel || noAuth || $('f-auth').value !== 'privatekey');
  $('lbl-passphrase').classList.toggle('hidden', isTunnel || noAuth);
  $('lbl-password').classList.toggle('hidden', p === 'raw' || noAuth || (!isTunnel && $('f-auth').value === 'privatekey'));
  const hints = {
    ssh: 'SSH：加密终端连接，支持密码与私钥认证。',
    telnet: 'Telnet：明文协议，请勿在不安全网络中传输敏感信息；填写用户名/密码可自动登录。',
    rlogin: 'RLOGIN：明文远程登录（RFC 1258），端口 513，安全性低，建议仅在可信网络使用。',
    sftp: 'SFTP：仅打开文件传输面板，不启动交互式 Shell。',
    ftp: 'FTP：传统文件传输协议（端口 21），明文传输，建议仅在可信网络使用。',
    rdp: 'RDP：Windows 远程桌面图形协议，将调用系统“远程桌面连接”程序打开，无法在终端内显示。',
    serial: 'Serial 串口：通过浏览器 Web Serial API 连接本地 COM 口，连接时请在弹窗中选择设备。',
    local: 'Local 本地终端：在本机启动系统 Shell（Windows 为 cmd），命令直接在本机执行。',
    raw: '原始 TCP：建立裸连接并透传字符，不做 Telnet 选项协商。'
  };
  $('protocol-hint').textContent = hints[p] || hints.ssh;
  toggleAuthFields();
}

/* ---------------- 标签与终端 ---------------- */
function terminalTheme(name) {
  if (name === 'light') return { background: '#ffffff', foreground: '#1f2329', cursor: '#2563eb', selectionBackground: '#bfdbfe' };
  if (name === 'solarized') return { background: '#002b36', foreground: '#eee8d5', cursor: '#2aa198', selectionBackground: '#586e75' };
  return { background: '#070d17', foreground: '#cbd5e1', cursor: '#38bdf8', selectionBackground: '#1e3a5f' };
}
function makeTerminal(tab) {
  const term = new Terminal({
    fontSize: getPrefs().fontSize || 14,
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
    scrollback: getPrefs().scrollback || 5000,
    cursorBlink: true,
    rightClickSelectsWord: false,
    theme: terminalTheme(getPrefs().theme)
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(tab.slot);
  setTimeout(() => { try { fit.fit(); } catch {} }, 30);
  term.onResize(({ rows, cols }) => {
    if (tab.type === 'ssh') api.sshResize(tab.id, cols, rows);
  });
  tab.term = term;
  tab.fit = fit;

  // 终端右键菜单：复制/粘贴/全选/清屏/重连
  term.element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    activateTab(tab.id);
    const menu = $('term-context-menu');
    menu.dataset.tabId = tab.id;
    // 有选中内容时"复制选中"可用，否则禁用提示
    const hasSel = !!term.getSelection();
    const copyBtn = menu.querySelector('[data-action="copy"]');
    copyBtn.style.opacity = hasSel ? '1' : '0.5';
    showTermMenu(e.clientX, e.clientY);
  });

  // 键盘快捷键（在终端内生效）：
  // Ctrl+Shift+C 复制选中；Ctrl+Shift+V 粘贴；Ctrl+Shift+A 全选
  term.element.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'c') { e.preventDefault(); e.stopPropagation(); copyTermSelection(tab); }
    else if (k === 'v') { e.preventDefault(); e.stopPropagation(); pasteToTerm(tab); }
    else if (k === 'a') { e.preventDefault(); e.stopPropagation(); term.selectAll(); }
  });

  // 选中即复制（可选习惯）：监听选择变化，有内容时自动写入剪贴板
  try {
    term.onSelectionChange(() => {
      if (!getPrefs().copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) api.writeClipboard(sel).catch(() => {});
    });
  } catch (_) {}
}

/* 终端右键菜单显示/隐藏 */
function showTermMenu(x, y) {
  const menu = $('term-context-menu');
  menu.classList.remove('hidden');
  const w = menu.offsetWidth || 160, h = menu.offsetHeight || 200;
  const px = Math.min(x, window.innerWidth - w - 8);
  const py = Math.min(y, window.innerHeight - h - 8);
  menu.style.left = Math.max(4, px) + 'px';
  menu.style.top = Math.max(4, py) + 'px';
}
function hideTermMenu() { $('term-context-menu').classList.add('hidden'); }

/* 复制终端选中内容 */
async function copyTermSelection(tab) {
  const t = tab || currentTab();
  if (!t || !t.term) { status('当前没有终端'); return; }
  const sel = t.term.getSelection();
  if (!sel) { status('没有选中内容'); return; }
  try { await api.writeClipboard(sel); status(`已复制 ${sel.length} 个字符`); }
  catch (e) { status('复制失败：' + (e.message || e)); }
}

/* 粘贴到当前终端（按标签类型选择通道） */
async function pasteToTerm(tab) {
  const t = tab || currentTab();
  if (!t || !t.term) { alert('请先打开一个终端标签。'); return; }
  let text = '';
  try { text = await api.readClipboard(); } catch (_) {}
  if (!text) { status('剪贴板为空'); return; }
  if (t.type === 'local') api.localWrite(t.id, text);
  else if (t.ftp) { status('FTP 标签不支持命令粘贴'); return; }
  else api.sshWrite(t.id, text);
  t.term.focus();
  status(`已粘贴 ${text.length} 个字符`);
}
function createTab(name, type = 'ssh') {
  const id = `tab-${++tabSeq}`;
  const tab = { id, name, type, term: null, fit: null, cwd: '.', serial: null, serialWriter: null, serialReading: false, onDataDisposable: null };
  tab.slot = document.createElement('div');
  tab.slot.className = 'terminal-slot';
  $('terminal-host').appendChild(tab.slot);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const label = document.createElement('span');
  label.className = 'tab-name';
  label.textContent = name;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(id); };
  tabEl.append(label, closeBtn);
  tabEl.onclick = () => activateTab(id);
  $('tabbar').appendChild(tabEl);
  tab.el = tabEl;

  tabs.set(id, tab);
  makeTerminal(tab);
  $('empty-state').classList.add('hidden');
  activateTab(id);
  return tab;
}
function activateTab(id) {
  activeTabId = id;
  tabs.forEach((t, key) => {
    const on = key === id;
    t.slot.classList.toggle('active', on);
    t.el.classList.toggle('active', on);
    if (on) setTimeout(() => { try { t.fit.fit(); t.term.focus(); } catch {} }, 10);
  });
}
function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.type === 'ssh') api.sshDisconnect(t.id);
  if (t.onDataDisposable) { try { t.onDataDisposable.dispose(); } catch {} }
  if (t.serialWriter) { try { t.serialWriter.releaseLock(); } catch {} }
  if (t.serial) { t.serialReading = false; try { t.serial.close(); } catch {} }
  if (t.term) { try { t.term.dispose(); } catch {} }
  t.slot.remove();
  t.el.remove();
  tabs.delete(id);
  if (activeTabId === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activateTab(rest[rest.length - 1]);
    else {
      activeTabId = null;
      $('empty-state').classList.remove('hidden');
      $('sftp-panel').classList.add('hidden');
    }
  }
}

/* ---------------- 全局事件（主进程 → 渲染） ---------------- */
api.on('ssh:data', (tabId, data) => {
  const tab = tabs.get(tabId);
  if (tab && tab.term) tab.term.write(String(data));
});
api.on('ssh:close', (tabId) => {
  const tab = tabId ? tabs.get(tabId) : currentTab();
  if (tab) tab.connState = 'closed';
  status('连接已关闭');
});
api.on('ssh:error', (tabId, message) => {
  const tab = tabs.get(tabId);
  if (tab) tab.connState = 'failed';
  if (tab && tab.term) tab.term.writeln('\x1b[31m[ERROR] ' + String(message) + '\x1b[0m');
  status('连接失败');
});
api.on('ssh:status', (_tabId, text) => status(String(text)));
api.on('ssh:progress', (tabId, text) => {
  const tab = tabs.get(tabId);
  if (tab && tab.term) tab.term.writeln(String(text));
});
api.on('ssh:forwardLog', (tabId, text) => {
  const tab = tabs.get(tabId);
  if (tab && tab.term) tab.term.writeln('\x1b[36m' + String(text) + '\x1b[0m');
});
api.on('sftp:progress', (tabId, name, transferred) => {
  status(`传输中 ${name}：${formatBytes(transferred)}`);
});

/* ---------------- SSH 连接 ---------------- */
/* 查找可复用的标签：同一会话、且处于失败/断开状态（避免重复开新标签） */
function findReusableTab(session) {
  const key = session.id || `${session.protocol}|${session.host}|${session.port}|${session.user}`;
  for (const tab of tabs.values()) {
    if (tab.sessionKey !== key) continue;
    // 只复用失败或已断开的连接标签，正在连接的标签不复用
    if (tab.connState === 'failed' || tab.connState === 'closed' || tab.connState === 'idle') return tab;
  }
  return null;
}

/* 在指定标签内执行实际连接（SSH/Telnet/RLOGIN/Raw/SFTP） */
async function connectIntoTab(tab, session, protocol) {
  const term = tab.term;
  tab.session = session;
  tab.sessionKey = session.id || `${protocol}|${session.host}|${session.port}|${session.user}`;
  tab.connState = 'connecting';
  let ver = '2.0.0';
  try { ver = await api.appVersion(); } catch (_) {}
  const cyan = '\x1b[36m', dim = '\x1b[2m', reset = '\x1b[0m';
  term.writeln(`${cyan}OpenShell ${ver}${reset} · ${protocol.toUpperCase()}`);
  term.writeln('Copyright (c) 2026 OpenShell contributors. All rights reserved.');
  term.writeln('');
  term.writeln(`${dim}输入 help 查看远程 Shell 的可用命令。${reset}`);
  term.writeln('');
  status(`正在连接 ${session.host}`);
  // 释放旧的数据监听，避免重连后重复绑定导致输入被发送两次
  if (tab.onDataDisposable) { try { tab.onDataDisposable.dispose(); } catch {} }
  tab.onDataDisposable = term.onData((data) => api.sshWrite(tab.id, data));
  const payload = { ...session, protocol, forwardRules: getForwarding() };
  try {
    if (['telnet', 'raw', 'rlogin'].includes(protocol)) await api.telnetConnect(tab.id, payload);
    else await api.sshConnect(tab.id, payload);
    tab.connState = 'connected';
    term.writeln('\x1b[32m连接成功。\x1b[0m');
    if (protocol === 'sftp') {
      setTimeout(() => {
        if (tabs.has(tab.id) && $('sftp-panel').classList.contains('hidden')) toggleSftp();
      }, 700);
    }
  } catch (e) {
    tab.connState = 'failed';
    // xterm 是终端渲染器而非 HTML，不做 HTML 转义（会显示成 &lt; 字面量）
    term.writeln('\x1b[31m[连接失败] ' + String(e && e.message ? e.message : e) + '\x1b[0m');
    term.writeln('\x1b[33m可在本标签右键选择“重新连接”，或从左侧会话列表再次连接（将在原标签重试）。\x1b[0m');
    status('连接失败');
  }
}

/* 在原标签重新连接 */
async function reconnectTab(tab, session) {
  if (!tab || !tabs.has(tab.id)) return;
  const protocol = Fmt.normalizeProtocol((session || tab.session || {}).protocol);
  // 清屏并停止旧数据监听，然后复用本标签重连
  if (tab.onDataDisposable) { try { tab.onDataDisposable.dispose(); } catch {} tab.onDataDisposable = null; }
  try { api.sshDisconnect(tab.id); } catch {}
  if (tab.term) tab.term.clear();
  await connectIntoTab(tab, session || tab.session, protocol);
}

async function connectSession(session) {
  const protocol = Fmt.normalizeProtocol(session.protocol);
  // RDP 是图形协议，无法在终端渲染，调用系统远程桌面客户端
  if (protocol === 'rdp') {
    try {
      const r = await api.rdpLaunch(session);
      status(r.ok ? (r.message || '已启动远程桌面') : (r.error || 'RDP 启动失败'));
      if (!r.ok) alert(r.error);
    } catch (e) { alert('RDP 启动失败：' + (e.message || e)); }
    return;
  }
  // 串口走 Web Serial，单独处理
  if (protocol === 'serial') { await openSerialTab(); return; }
  // 本地终端：启动系统 shell
  if (protocol === 'local') {
    const tab = createTab('本地终端', 'local');
    tab.protocol = 'local';
    tab.session = session;
    tab.connState = 'idle';
    const term = tab.term;
    term.writeln('\x1b[36mOpenShell 网络版 · 本地终端\x1b[0m');
    term.writeln('\x1b[2m输入 exit 退出；本地终端直接在你的电脑上执行命令。\x1b[0m\r\n');
    status('正在启动本地终端…');
    tab.onDataDisposable = term.onData((data) => api.localWrite(tab.id, data));
    try { await api.localSpawn(tab.id); tab.connState = 'connected'; }
    catch (e) { tab.connState = 'failed'; term.writeln('\x1b[31m[启动失败] ' + String(e && e.message ? e.message : e) + '\x1b[0m'); status('启动失败'); }
    return;
  }
  // FTP：建立控制连接，文件列表通过 FTP 面板呈现
  if (protocol === 'ftp') {
    const tab = createTab(session.name || `${session.user}@${session.host}`, 'ftp');
    tab.protocol = 'ftp';
    tab.session = session;
    tab.sessionKey = session.id || `ftp|${session.host}|${session.port}|${session.user}`;
    tab.connState = 'connecting';
    const term = tab.term;
    term.writeln('\x1b[36mOpenShell 网络版 · FTP\x1b[0m');
    term.writeln('\x1b[2mFTP 为文件传输协议，双击会话后可在文件面板列出远程目录。\x1b[0m\r\n');
    status(`正在连接 FTP ${session.host}`);
    try {
      await api.ftpConnect(tab.id, { ...session, protocol });
      tab.connState = 'connected';
      term.writeln('\x1b[32mFTP 已连接。点击工具栏“文件”查看远程目录。\x1b[0m');
    } catch (e) {
      tab.connState = 'failed';
      term.writeln('\x1b[31m[连接失败] ' + String(e && e.message ? e.message : e) + '\x1b[0m');
      term.writeln('\x1b[33m可在本标签右键选择“重新连接”重试。\x1b[0m');
      status('连接失败');
    }
    return;
  }
  // SSH / Telnet / RLOGIN / Raw / SFTP：优先复用同会话的失败/断开标签
  let tab = findReusableTab(session);
  let reused = false;
  if (tab) {
    reused = true;
    activateTab(tab.id);
    if (tab.term) tab.term.clear();
  } else {
    tab = createTab(session.name || `${session.user}@${session.host}`, 'ssh');
  }
  tab.protocol = protocol;
  if (reused) status(`正在原标签重新连接 ${session.host}`);
  await connectIntoTab(tab, session, protocol);
}

/* ---------------- SFTP ---------------- */
function currentTab() { return activeTabId ? tabs.get(activeTabId) : null; }
function toggleSftp() {
  const panel = $('sftp-panel');
  const showing = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', showing);
  if (!showing) {
    const tab = currentTab();
    if (tab && tab.type === 'ssh') loadSftpDir(tab, tab.cwd);
    else $('sftp-list').textContent = '当前标签没有 SFTP 会话';
  }
}
async function loadSftpDir(tab, dir) {
  if (!tab || tab.type !== 'ssh') return;
  tab.cwd = dir || '.';
  $('sftp-path').textContent = tab.cwd;
  $('sftp-list').textContent = '读取中…';
  try {
    const list = await api.sftpReaddir(tab.id, tab.cwd);
    const host = $('sftp-list');
    host.textContent = '';
    if (tab.cwd !== '/' && tab.cwd !== '.') {
      const up = document.createElement('div');
      up.className = 'sftp-row dir';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '📁';
      const fname = document.createElement('span');
      fname.className = 'fname';
      fname.textContent = '..';
      up.append(icon, fname);
      up.onclick = () => loadSfptdirSafe(tab, posixDirname(tab.cwd));
      host.appendChild(up);
    }
    list.sort((a, b) => (!!(b.attrs.mode & 0o040000)) - (!!(a.attrs.mode & 0o040000)) || a.filename.localeCompare(b.filename));
    list.forEach((entry) => {
      const isDir = !!(entry.attrs.mode & 0o040000);
      const row = document.createElement('div');
      row.className = 'sftp-row' + (isDir ? ' dir' : '');
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = isDir ? '📁' : '📄';
      const fname = document.createElement('span');
      fname.className = 'fname';
      fname.textContent = entry.filename;
      const fsize = document.createElement('span');
      fsize.className = 'fsize';
      fsize.textContent = isDir ? '' : formatBytes(entry.attrs.size);
      row.append(icon, fname, fsize);
      row.onclick = () => {
        selectedSftpRow = { row, entry, tabId: tab.id };
        [...host.children].forEach((c) => c.style.background = '');
        row.style.background = 'var(--panel-2)';
      };
      row.ondblclick = () => { if (isDir) loadSfptdirSafe(tab, posixJoin(tab.cwd, entry.filename)); };
      host.appendChild(row);
    });
  } catch (e) {
    $('sftp-list').textContent = '';
    const div = document.createElement('div');
    div.className = 'danger';
    div.style.padding = '12px';
    div.textContent = e.message || String(e);
    $('sftp-list').appendChild(div);
  }
}
function loadSfptdirSafe(tab, dir) { loadSftpDir(tab, dir).catch(() => {}); }
function remotePath(name) {
  const tab = currentTab();
  if (!tab) return '';
  const base = tab.cwd === '.' ? '' : tab.cwd.replace(/\/$/, '') + '/';
  return base + name;
}

/* ---------------- 端口转发 ---------------- */
function getForwarding() { return loadJSON(FW_KEY, []); }
function renderForwarding() {
  const host = $('fw-list');
  host.textContent = '';
  getForwarding().forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'fw-row';
    const code = document.createElement('code');
    code.textContent = `127.0.0.1:${r.local} → ${r.host}:${r.remote}`;
    const btn = document.createElement('button');
    btn.textContent = '删除';
    btn.onclick = () => {
      const list = getForwarding();
      list.splice(i, 1);
      saveJSON(FW_KEY, list);
      renderForwarding();
    };
    row.append(code, btn);
    host.appendChild(row);
  });
}

/* ---------------- 串口 ---------------- */
async function openSerialTab() {
  if (!navigator.serial) {
    alert('当前 Electron 版本不支持 Web Serial API。');
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    const tab = createTab(`串口 ${Date.now().toString().slice(-4)}`, 'serial');
    tab.serial = port;
    tab.term.writeln('\x1b[32mSerial port opened at 115200 8N1.\x1b[0m');
    const decoder = new TextDecoder();
    const writer = port.writable.getWriter();
    tab.serialWriter = writer;
    tab.serialReading = true;
    tab.onDataDisposable = tab.term.onData((data) => {
      writer.write(new TextEncoder().encode(data)).catch(() => {});
    });
    (async () => {
      while (tab.serialReading && port.readable) {
        const reader = port.readable.getReader();
        try {
          while (tab.serialReading) {
            const { value, done } = await reader.read();
            if (done) break;
            if (tab.term) tab.term.write(decoder.decode(value, { stream: true }));
          }
        } catch (e) {
          if (tab.term) tab.term.writeln(`\r\n\x1b[31m[Serial] ${e.message}\x1b[0m`);
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      }
    })();
  } catch (e) {
    alert(`打开串口失败：${e.message}`);
  }
}

/* ---------------- 偏好设置 ---------------- */
function getPrefs() { return loadJSON(PREFS_KEY, { theme: 'dark', fontSize: 14, scrollback: 5000 }); }
function applyPrefs() {
  const p = getPrefs();
  document.body.dataset.theme = p.theme;
  tabs.forEach((t) => {
    t.term.options.fontSize = p.fontSize;
    t.term.options.theme = terminalTheme(p.theme);
    setTimeout(() => { try { t.fit.fit(); } catch {} }, 10);
  });
}
function openSettings() {
  const p = getPrefs();
  $('s-theme').value = p.theme;
  $('s-fontsize').value = p.fontSize;
  $('s-scrollback').value = p.scrollback;
  if ($('s-copyonselect')) $('s-copyonselect').checked = !!p.copyOnSelect;
  $('settings-modal').classList.remove('hidden');
}

/* ---------------- 批量导入 / 导出 ---------------- */
function sessionKey(s) { return `${String(s.host || '').toLowerCase()}|${Number(s.port) || 22}|${String(s.user || '').toLowerCase()}`; }

function renderBatchImportList() {
  const host = $('bi-list');
  host.textContent = '';
  batchImportFiles.forEach((f, idx) => {
    const row = document.createElement('div');
    row.className = 'batch-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.selected !== false && !f.error;
    cb.disabled = !!f.error;
    cb.onchange = () => { f.selected = cb.checked; };
    const name = document.createElement('span');
    name.className = 'bname';
    name.textContent = f.name || '(未命名文件)';
    name.title = f.sourcePath || f.name || '';
    const fmt = document.createElement('span');
    fmt.className = 'bfmt';
    let count = 0;
    let format = '未知';
    try {
      const result = Fmt.parseFile(f);
      format = result.format;
      count = (result.sessions || []).length;
    } catch (_) { format = '解析失败'; }
    fmt.textContent = format;
    const num = document.createElement('span');
    num.className = 'bnum';
    num.textContent = `${count} 个会话`;
    row.append(cb, name, fmt, num);
    if (f.error) {
      const err = document.createElement('span');
      err.className = 'berr';
      err.textContent = f.error;
      row.appendChild(err);
    }
    host.appendChild(row);
  });
  const total = batchImportFiles.length;
  const errs = batchImportFiles.filter((f) => f.error).length;
  $('bi-count').textContent = total ? `共 ${total} 个文件（${errs} 个读取失败）` : '尚未添加文件';
  $('btn-bi-do').disabled = !batchImportFiles.some((f) => f.selected !== false && !f.error);
}

function openBatchImport() {
  batchImportFiles = [];
  renderBatchImportList();
  $('bi-summary').textContent = '第三方客户端密码为私有加密，无法还原，导入后需重新填写。';
  $('batch-import-modal').classList.remove('hidden');
}

function addImportFiles(files, extra) {
  const incoming = (files || []).map((f) => ({ ...f, selected: true }));
  const seen = new Set(batchImportFiles.map((f) => f.sourcePath || f.name));
  incoming.forEach((f) => {
    const key = f.sourcePath || f.name;
    if (!seen.has(key)) { batchImportFiles.push(f); seen.add(key); }
  });
  if (extra && extra.skipped && extra.skipped.length) {
    extra.skipped.forEach((s) => batchImportFiles.push({
      name: String(s.path || '').split(/[\\/]/).pop() || '未知文件',
      text: '', selected: false, error: s.error
    }));
  }
  renderBatchImportList();
}

async function doBatchImport() {
  const selected = batchImportFiles.filter((f) => f.selected !== false && !f.error);
  if (!selected.length) return alert('请先选择要导入的文件。');
  const dedupe = $('bi-dedupe').checked;
  const override = $('bi-group-override').checked;
  const overrideGroup = $('bi-group-name').value.trim();
  const existing = getSessions();
  const existingKeys = new Set(existing.map(sessionKey));
  const all = [];
  const stats = {};
  let duplicates = 0;
  let vaultPayload = '';
  for (const f of selected) {
    try {
      const result = Fmt.parseFile(f);
      const sessions = normalizeImported(result.sessions || []).map((s, i) => {
        const src = (result.sessions || [])[i] || {};
        s.credentialId = src.credentialId || src.id || s.id;
        if (override) s.group = overrideGroup;
        return s;
      });
      if (result.vault) vaultPayload = result.vault;
      for (const s of sessions) {
        const key = sessionKey(s);
        if (dedupe && (existingKeys.has(key) || all.some((x) => sessionKey(x) === key))) { duplicates++; continue; }
        existingKeys.add(key);
        all.push(s);
      }
      stats[result.format] = (stats[result.format] || 0) + sessions.length;
    } catch (_) { stats['解析失败'] = (stats['解析失败'] || 0) + 1; }
  }
  if (all.length) saveSessions([...existing, ...all]);
  let pwMsg = '密码需重新填写。';
  if (vaultPayload && all.length) {
    const vr = await decryptVaultOnImport(vaultPayload);
    pwMsg = vr.message || pwMsg;
  }
  const summary = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('，') || '无';
  $('bi-summary').textContent = `已导入 ${all.length} 个会话，跳过重复 ${duplicates} 个（${summary}）。${pwMsg}`;
  status(`批量导入完成：${all.length} 个会话`);
  if (all.length) alert(`批量导入完成：${all.length} 个会话，跳过重复 ${duplicates} 个。\n${pwMsg}`);
}

function openBatchExport() {
  $('be-group').disabled = $('be-all').checked;
  const groups = [...new Set(getSessions().map((s) => s.group || '默认分组'))].sort();
  const sel = $('be-group');
  sel.textContent = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = '（全部分组）';
  sel.appendChild(opt);
  groups.forEach((g) => {
    const o = document.createElement('option');
    o.value = g; o.textContent = g;
    sel.appendChild(o);
  });
  $('be-dir').value = outputPaths.exports;
  $('be-summary').textContent = '准备就绪。';
  $('batch-export-modal').classList.remove('hidden');
}

async function doBatchExport() {
  const all = getSessions();
  // be-all 与「仅分组」互斥：只有取消「全部会话」时才按分组过滤
  const group = $('be-all').checked ? '' : $('be-group').value;
  const list = group ? all.filter((s) => (s.group || '默认分组') === group) : all;
  if (!list.length) { alert('没有符合条件的会话可导出。'); return; }
  const defaultDir = $('be-dir').value.trim() || outputPaths.exports;
  const dir = await api.selectExportDir(defaultDir);
  if (!dir) { $('be-summary').textContent = '已取消导出。'; status('已取消导出'); return; }
  const useSub = $('be-subdir').checked;
  const files = [];
  const counts = {};
  let pwNote = '';
  if ($('be-fmt-openshell').checked) {
    const includePw = $('opt-include-password-batch') ? $('opt-include-password-batch').checked : true;
    const vr = await buildVaultPayload(list, includePw);
    if (vr === null) { $('be-summary').textContent = '已取消导出。'; return; }
    const out = Fmt.toOpenShell(list, vr.payload);
    files.push({ name: useSub ? 'openshell/' + out.name : out.name, content: out.content });
    counts['OpenShell'] = 1;
    pwNote = vr.note;
  }
  if ($('be-fmt-xshell').checked) {
    list.forEach((s) => {
      const out = Fmt.toXshell(s);
      files.push({ name: (useSub ? 'xshell/' : '') + out.name.replace(/\.xsh$/i, '') + '-' + Fmt.safeName(s.host) + '.xsh', content: out.content });
    });
    counts['Xshell'] = list.length;
  }
  if ($('be-fmt-securecrt').checked) {
    list.forEach((s) => {
      const out = Fmt.toSecureCrt(s);
      files.push({ name: (useSub ? 'securecrt/' : '') + out.name.replace(/\.ini$/i, '') + '-' + Fmt.safeName(s.host) + '.ini', content: out.content });
    });
    counts['SecureCRT'] = list.length;
  }
  if (!files.length) { alert('请至少选择一种导出格式。'); return; }
  try {
    const result = await api.writeExportFiles(dir, files);
    const summary = Object.entries(counts).map(([k, v]) => `${k} ${v} 个`).join('，');
    $('be-summary').textContent = `已导出 ${result.count} 个文件到 ${dir}（${summary}）` +
      (result.errors && result.errors.length ? `；失败 ${result.errors.length} 个` : '') + '。' + (pwNote ? ` 密码：${pwNote}。` : '');
    status(`批量导出完成：${result.count} 个文件`);
    alert(`批量导出完成：${result.count} 个文件\n${dir}` + (pwNote ? `\n密码：${pwNote}` : '\n第三方格式不含密码。'));
  } catch (e) { alert('导出失败：' + (e.message || String(e))); }
}

function normalizeImported(list) {
  return list.filter((s) => s && s.host && s.user).map((s) => ({
    id: `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: String(s.name || s.host).slice(0, 80),
    group: String(s.group || '').slice(0, 60),
    host: String(s.host).slice(0, 255),
    port: Math.min(65535, Math.max(1, Number(s.port) || Fmt.defaultPort(Fmt.normalizeProtocol(s.protocol)))),
    user: String(s.user).slice(0, 128),
    protocol: Fmt.normalizeProtocol(s.protocol),
    auth: s.auth === 'privatekey' ? 'privatekey' : 'password',
    keyfile: String(s.keyfile || '').slice(0, 500),
    credentialId: '',
    needsCredential: true
  }));
}
async function importSessions() {
  const files = await api.selectImportFiles();
  if (!files.length) return;
  const all = [];
  const stats = {};
  let vaultPayload = '';
  for (const f of files) {
    if (f.error || !Fmt) { stats.unknown = (stats.unknown || 0) + 1; continue; }
    try {
      const result = Fmt.parseFile(f);
      const sessions = normalizeImported(result.sessions || []);
      // 还原会话 id，使导入的密码能对应到凭据
      (result.sessions || []).forEach((src, i) => { if (sessions[i]) sessions[i].credentialId = src.credentialId || src.id || sessions[i].id; });
      all.push(...sessions);
      stats[result.format] = (stats[result.format] || 0) + sessions.length;
      if (result.vault) vaultPayload = result.vault;
    } catch { stats.unknown = (stats.unknown || 0) + 1; }
  }
  if (!all.length) {
    alert('未从所选文件中解析出有效会话。\n\n支持：OpenShell JSON（含加密密码保险库）、Xshell .xsh、SecureCRT .ini。');
    return;
  }
  saveSessions([...getSessions(), ...all]);
  const summary = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n');
  let pwMsg = '\n\n密码未导入，请在会话编辑中重新填入。';
  if (vaultPayload) {
    const vr = await decryptVaultOnImport(vaultPayload);
    pwMsg = '\n\n密码还原：' + vr.message;
  }
  alert(`已导入 ${all.length} 个会话：\n${summary}${pwMsg}`);
}
/* ---------------- 主密码保险库：导出/导入密码 ----------------
   导出：默认导出密码，先验证主密码，用主密码加密密码字典写入会话文件。
   导入：检测到加密保险库时要求输入主密码，仅主密码一致才能还原密码。
   用户可随时勾选"清除密码"选择不导出。                                */
async function buildVaultPayload(selectedSessions, includePassword) {
  const include = typeof includePassword === 'boolean' ? includePassword : ($('opt-include-password') ? $('opt-include-password').checked : true);
  if (!include) return { payload: '', note: '已按你的选择清除密码' };
  // 校验主密码是否已设置
  const status = await api.vaultStatus();
  if (!status.configured) {
    if (!confirm('尚未设置主密码。\n\n导出密码需要先设置一个主密码（用于加密保护，只有主密码相同的电脑才能导入还原）。\n\n点击“确定”前往设置主密码，或“取消”导出不含密码的会话。')) {
      return { payload: '', note: '未设置主密码，已清除密码导出' };
    }
    openMasterModal();
    return null; // 让用户在设置完主密码后重新点击导出
  }
  const pw = prompt('请输入工具主密码以加密导出密码：');
  if (pw === null) return null; // 用户取消整个导出
  const verify = await api.vaultVerifyMaster(pw);
  if (!verify.ok) { alert('主密码错误，已取消导出。'); return null; }
  const allCreds = await api.exportAllCredentials();
  // 仅保留本次导出会话涉及的凭据
  const ids = new Set(selectedSessions.map((s) => s.credentialId || s.id));
  const secrets = {};
  Object.entries(allCreds).forEach(([id, v]) => { if (ids.has(id)) secrets[id] = v; });
  const enc = await api.vaultEncrypt(pw, secrets);
  if (!enc.ok) { alert('密码加密失败：' + enc.error); return null; }
  return { payload: enc.payload, note: Object.keys(secrets).length ? `已加密导出 ${Object.keys(secrets).length} 个会话的密码` : '本次导出没有可导出的密码' };
}

async function decryptVaultOnImport(vaultPayload) {
  if (!vaultPayload) return { restored: 0, message: '' };
  const pw = prompt('该文件包含加密密码。请输入工具主密码以还原密码：\n（只有与导出时相同的主密码才能还原）');
  if (pw === null) return { restored: 0, message: '已跳过密码还原', skipped: true };
  const dec = await api.vaultDecrypt(pw, vaultPayload);
  if (!dec.ok) { alert('密码还原失败：' + dec.error + '\n\n会话将正常导入，但密码需重新填写。'); return { restored: 0, message: '主密码不匹配，密码未还原' }; }
  const imp = await api.importCredentials(dec.secrets);
  return { restored: imp.count || 0, message: imp.ok ? `已还原 ${imp.count} 个密码` : '密码写入失败' };
}

async function exportSessions(format) {
  const list = getSessions();
  if (!list.length) { alert('没有可导出的会话。'); return; }
  const dir = await api.selectExportDir(outputPaths.exports);
  if (!dir) { status('已取消导出'); return; }
  let files = [];
  let pwNote = '';
  if (format === 'openshell') {
    // OpenShell JSON 支持主密码加密的密码保险库
    const vr = await buildVaultPayload(list);
    if (vr === null) { status('已取消导出'); return; }
    files = [Fmt.toOpenShell(list, vr.payload)];
    pwNote = '\n\n' + vr.note;
  } else {
    // 第三方格式仍不写密码（其加密格式私有，无法安全写入）
    const generator = format === 'xshell' ? Fmt.toXshell : Fmt.toSecureCrt;
    files = list.map(generator);
    pwNote = '\n\n第三方格式不写入密码，请在目标客户端中重新输入。';
  }
  const result = await api.writeExportFiles(dir, files);
  alert(`已导出 ${result.count} 个文件到：\n${dir}` + (result.errors?.length ? `\n\n失败：\n${result.errors.join('\n')}` : '') + pwNote);
}

/* ---------------- 事件绑定 ---------------- */
$('btn-new-session').onclick = () => openSessionModal();
$('session-filter').oninput = renderSessions;
$('f-auth').onchange = toggleAuthFields;
$('f-protocol').onchange = () => {
  const p = $('f-protocol').value;
  const current = Number($('f-port').value);
  const def = Fmt.defaultPort(p);
  if (!current || current === 22 || current === 23) $('f-port').value = def;
  toggleProtocolFields();
};
$('btn-pick-key').onclick = async () => {
  const p = await api.selectPrivateKey();
  if (p) $('f-keyfile').value = p;
};
document.querySelectorAll('.modal-close, .cancel').forEach((b) => {
  b.onclick = () => b.closest('.modal').classList.add('hidden');
});
$('btn-session-save').onclick = async () => {
  const name = $('f-name').value.trim();
  const host = $('f-host').value.trim();
  const user = $('f-user').value.trim();
  const proto = $('f-protocol').value;
  // local/serial 不需要主机；raw 需要主机但不需要用户
  const needHost = !['local', 'serial'].includes(proto);
  const needUser = !['raw', 'local', 'serial', 'rdp'].includes(proto);
  if (!name || (needHost && !host) || (needUser && !user)) {
    alert('会话名称为必填项' + (needHost ? '，主机地址也必填' : '') + (needUser ? '，用户名也必填' : '') + '。');
    return;
  }
  const id = editingSessionId || `s-${Date.now()}`;
  const password = $('f-password').value;
  const passphrase = $('f-passphrase').value;
  const s = {
    id,
    name,
    group: $('f-group').value.trim(),
    host,
    port: Math.min(65535, Math.max(1, Number($('f-port').value) || Fmt.defaultPort($('f-protocol').value))),
    user,
    protocol: Fmt.normalizeProtocol($('f-protocol').value),
    auth: $('f-auth').value,
    keyfile: $('f-keyfile').value.trim(),
    credentialId: id,
    needsCredential: !!(password || passphrase)
  };
  if (password || passphrase) {
    const r = await api.saveCredential(id, password, passphrase);
    if (!r.ok) { alert('凭据加密保存失败：' + (r.error || '未知错误')); return; }
  }
  const list = getSessions();
  const idx = list.findIndex((x) => x.id === id);
  if (idx >= 0) list[idx] = s; else list.push(s);
  saveSessions(list);
  $('session-modal').classList.add('hidden');
  status(`会话已保存：${s.name}`);
};
$('btn-session-delete').onclick = async () => {
  if (!editingSessionId || !confirm('删除该会话？')) return;
  await api.removeCredential(editingSessionId);
  saveSessions(getSessions().filter((x) => x.id !== editingSessionId));
  $('session-modal').classList.add('hidden');
};
$('btn-quick-connect').onclick = () => openSessionModal();
$('btn-import-sessions').onclick = importSessions;
$('btn-export-openshell').onclick = () => exportSessions('openshell');
$('btn-export-xshell').onclick = () => exportSessions('xshell');
$('btn-export-securecrt').onclick = () => exportSessions('securecrt');
$('btn-open-export-dir').onclick = () => api.openOutputDir('exports').catch(() => {});

/* 会话列表右键菜单 */
$('session-tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.session-item');
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.id;
  selectedSessionId = id;
  renderSessions();
  const menu = $('context-menu');
  menu.dataset.id = id;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
  menu.classList.remove('hidden');
});
document.addEventListener('click', () => {
  $('context-menu').classList.add('hidden');
  $('term-context-menu').classList.add('hidden');
});
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.session-item') && !e.target.closest('#context-menu')) {
    $('context-menu').classList.add('hidden');
  }
  // 终端右键菜单：点击非菜单、非终端区域时关闭
  if (!e.target.closest('#term-context-menu') && !e.target.closest('.xterm')) {
    $('term-context-menu').classList.add('hidden');
  }
});
document.querySelectorAll('#term-context-menu button[data-action]').forEach((btn) => {
  btn.onclick = async (e) => {
    e.stopPropagation();
    const tabId = $('term-context-menu').dataset.tabId;
    const tab = tabs.get(tabId) || currentTab();
    const action = btn.dataset.action;
    hideTermMenu();
    if (!tab) { alert('当前没有终端标签。'); return; }
    if (action === 'copy') copyTermSelection(tab);
    else if (action === 'paste') pasteToTerm(tab);
    else if (action === 'select-all') { try { tab.term.selectAll(); tab.term.focus(); } catch {} }
    else if (action === 'clear') { if (tab.term) { tab.term.clear(); status('当前终端已清空'); } }
    else if (action === 'reconnect') {
      const s = tab.session;
      if (s) reconnectTab(tab, s);
      else { closeTab(tab.id); alert('该标签没有关联会话，请从左侧会话列表重新连接。'); }
    }
  };
});
document.querySelectorAll('#context-menu button[data-action]').forEach((btn) => {
  btn.onclick = async (e) => {
    e.stopPropagation();
    const id = $('context-menu').dataset.id;
    const s = getSessions().find((x) => x.id === id);
    $('context-menu').classList.add('hidden');
    if (!s) return;
    const action = btn.dataset.action;
    if (action === 'connect') connectSession(s);
    else if (action === 'edit') openSessionModal(s.id);
    else if (action === 'duplicate') {
      const copy = {
        ...s,
        id: `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        name: `${s.name} - 副本`,
        credentialId: ''
      };
      saveSessions([...getSessions(), copy]);
      status('会话已复制，请重新填写凭据');
    } else if (action === 'delete') {
      if (!confirm(`删除会话「${s.name}」？`)) return;
      await api.removeCredential(s.id);
      if (selectedSessionId === s.id) selectedSessionId = null;
      saveSessions(getSessions().filter((x) => x.id !== s.id));
      status('会话已删除');
    }
  };
});

/* 批量导入事件 */
$('btn-batch-import').onclick = openBatchImport;
$('btn-bi-files').onclick = async () => {
  const files = await api.selectImportFiles();
  if (files && files.length) addImportFiles(files);
};
$('btn-bi-dir').onclick = async () => {
  const result = await api.selectImportDir();
  if (result && result.files && result.files.length) addImportFiles(result.files, result);
  else if (result && result.skipped && result.skipped.length) addImportFiles([], result);
  else if (result && result.dir) alert('该目录中没有找到可导入的会话文件。');
};
$('btn-bi-clear').onclick = () => { batchImportFiles = []; renderBatchImportList(); };
$('bi-group-override').onchange = (e) => { $('bi-group-name').disabled = !e.target.checked; };
$('btn-bi-do').onclick = doBatchImport;

/* 批量导出事件 */
$('be-all').onchange = (e) => { $('be-group').disabled = e.target.checked; };
$('btn-batch-export').onclick = openBatchExport;
$('btn-be-pick').onclick = async () => {
  const dir = await api.selectExportDir();
  if (dir) $('be-dir').value = dir;
};
$('btn-be-do').onclick = doBatchExport;
$('btn-be-open').onclick = () => api.openOutputDir('exports').catch(() => {});

/* 顶部中文菜单 */
document.querySelectorAll('.menu-trigger').forEach((btn) => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = btn.closest('.menu');
    const wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
  };
});
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open')));

function selectedSession() {
  return selectedSessionId ? getSessions().find((s) => s.id === selectedSessionId) : null;
}
function setThemeAndSave(theme) {
  const p = getPrefs(); p.theme = theme;
  saveJSON(PREFS_KEY, p); applyPrefs();
}
const menuActions = {
  'copy-selection': async () => {
    const t = currentTab();
    const text = t && t.term ? t.term.getSelection() : '';
    if (!text) { status('当前没有选中内容'); return; }
    await api.writeClipboard(text);
    status('已复制选中内容');
  },
  'paste': async () => {
    const t = currentTab();
    if (!t) { alert('请先打开一个终端标签。'); return; }
    const text = await api.readClipboard();
    if (text) api.sshWrite(t.id, text);
    else status('剪贴板为空');
  },
  'duplicate-selected': () => {
    const s = selectedSession();
    if (!s) { alert('请先在左侧选择一个会话。'); return; }
    const copy = {
      ...s,
      id: `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: `${s.name} - 副本`,
      credentialId: ''
    };
    saveSessions([...getSessions(), copy]);
    status('会话已复制，请重新填写凭据');
  },
  'clear-terminal': () => {
    const t = currentTab();
    if (t && t.term) { t.term.clear(); status('当前终端已清空'); }
    else alert('请先打开一个终端标签。');
  },
  'compare': () => $('compare-modal').classList.remove('hidden'),
  'new-session': () => openSessionModal(),
  'quick-connect': () => openSessionModal(),
  'batch-import': openBatchImport,
  'batch-export': openBatchExport,
  'open-exports': () => api.openOutputDir('exports').catch(() => {}),
  'open-downloads': () => api.openOutputDir('downloads').catch(() => {}),
  'connect-selected': () => { const s = selectedSession(); if (s) connectSession(s); else alert('请先在左侧选择一个会话。'); },
  'edit-selected': () => { const s = selectedSession(); if (s) openSessionModal(s.id); else alert('请先在左侧选择一个会话。'); },
  'delete-selected': async () => {
    const s = selectedSession();
    if (!s) { alert('请先在左侧选择一个会话。'); return; }
    if (!confirm(`删除会话「${s.name}」？`)) return;
    await api.removeCredential(s.id);
    saveSessions(getSessions().filter((x) => x.id !== s.id));
    selectedSessionId = null; renderSessions(); status('会话已删除');
  },
  'disconnect-current': () => { const t = currentTab(); if (t && t.type === 'ssh') { api.sshDisconnect(t.id); status('已断开当前连接'); } else alert('当前标签没有 SSH 连接。'); },
  'close-current': () => { if (activeTabId) closeTab(activeTabId); },
  'sftp-toggle': toggleSftp,
  'forwarding': () => { renderForwarding(); $('forward-modal').classList.remove('hidden'); },
  'serial': openSerialTab,
  'script': () => $('script-modal').classList.remove('hidden'),
  'topology': () => { api.openTopology().catch((e) => alert('打开拓扑工具失败：' + (e.message || e))); },
  'linux-cmd': openLinuxModal,
  'deploy-config': openDeployModal,
  'master-password': openMasterModal,
  'settings': openSettings,
  'theme-dark': () => setThemeAndSave('dark'),
  'theme-light': () => setThemeAndSave('light'),
  'theme-solarized': () => setThemeAndSave('solarized'),
  'font-larger': () => { const p = getPrefs(); p.fontSize = Math.min(24, (p.fontSize || 14) + 1); saveJSON(PREFS_KEY, p); applyPrefs(); },
  'font-smaller': () => { const p = getPrefs(); p.fontSize = Math.max(10, (p.fontSize || 14) - 1); saveJSON(PREFS_KEY, p); applyPrefs(); },
  'about': async () => {
    let ver = '2.0.0';
    try { ver = await api.appVersion(); } catch (_) {}
    const mode = outputPaths.portable ? '便携模式（数据随程序目录）' : '标准模式';
    alert(`OpenShell 网络版 ${ver}\n开源 · 多协议 · 无注册 · 无有效期\n\n运行模式：${mode}\n默认输出目录：\n${outputPaths.root}\n\n许可证：MIT`);
  }
};
document.querySelectorAll('.menu-popup button[data-action]').forEach((btn) => {
  btn.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
    const fn = menuActions[btn.dataset.action];
    if (fn) Promise.resolve(fn()).catch((err) => alert('操作失败：' + (err.message || String(err))));
  };
});

function bind(id, handler) { const el = $(id); if (el) el.onclick = handler; }
bind('btn-settings', openSettings);
$('btn-settings-save').onclick = () => {
  saveJSON(PREFS_KEY, {
    theme: $('s-theme').value,
    fontSize: Math.min(24, Math.max(10, Number($('s-fontsize').value) || 14)),
    scrollback: Math.min(50000, Math.max(1000, Number($('s-scrollback').value) || 5000)),
    copyOnSelect: $('s-copyonselect') ? $('s-copyonselect').checked : false
  });
  applyPrefs();
  $('settings-modal').classList.add('hidden');
};

bind('btn-forwarding', () => { renderForwarding(); $('forward-modal').classList.remove('hidden'); });
$('btn-fw-add').onclick = () => {
  const rule = { local: Number($('fw-local').value), host: $('fw-host').value.trim(), remote: Number($('fw-remote').value) };
  if (!rule.local || !rule.host || !rule.remote || rule.local < 1 || rule.local > 65535 || rule.remote < 1 || rule.remote > 65535) {
    alert('请填写有效的转发规则（端口 1-65535）。'); return;
  }
  const list = getForwarding();
  list.push(rule);
  saveJSON(FW_KEY, list);
  $('fw-local').value = $('fw-host').value = $('fw-remote').value = '';
  renderForwarding();
  status('转发规则已保存；重新连接后生效');
};

bind('btn-script', () => $('script-modal').classList.remove('hidden'));
bind('btn-serial', openSerialTab);
$('btn-script-run').onclick = async () => {
  const tab = currentTab();
  if (!tab || (tab.type !== 'ssh' && tab.type !== 'telnet')) { alert('当前标签没有可用的终端会话。'); return; }
  if (scriptRunning) { scriptRunning = false; status('脚本已停止'); return; }
  const lines = $('script-text').value.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return;
  const delay = Math.max(50, Number($('script-delay').value) || 300);
  scriptRunning = true;
  $('btn-script-run').textContent = '停止发送';
  let sent = 0;
  for (const line of lines) {
    if (!scriptRunning || !tabs.has(tab.id)) break;
    api.sshWrite(tab.id, line + '\n');
    sent++;
    await new Promise((r) => setTimeout(r, delay));
  }
  scriptRunning = false;
  $('btn-script-run').textContent = '发送到当前终端';
  status(`[Script] 已发送 ${sent} 行`);
  $('script-modal').classList.add('hidden');
};

$('btn-sftp-close').onclick = () => $('sftp-panel').classList.add('hidden');
$('btn-sftp-toggle').onclick = toggleSftp;
$('btn-sftp-refresh').onclick = () => { const t = currentTab(); if (t && t.type === 'ssh') loadSfptdirSafe(t, t.cwd); };
$('btn-sftp-up').onclick = () => { const t = currentTab(); if (t && t.type === 'ssh') loadSfptdirSafe(t, posixDirname(t.cwd)); };
$('btn-sftp-upload').onclick = () => $('upload-file').click();
$('upload-file').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  const t = currentTab();
  e.target.value = '';
  if (!files.length || !t || t.type !== 'ssh') { alert('请先打开一个 SSH 终端标签。'); return; }
  let ok = 0;
  const failed = [];
  for (const file of files) {
    try {
      const localPath = api.getPathForFile(file);
      if (!localPath) { failed.push(file.name + ': 无法读取本地路径'); continue; }
      await api.sftpUpload(t.id, localPath, remotePath(file.name));
      ok++;
      status(`已上传 ${file.name}`);
    } catch (err) { failed.push(file.name + ': ' + (err.message || String(err))); }
  }
  loadSfptdirSafe(t, t.cwd);
  if (failed.length) alert(`上传完成 ${ok} 个，失败 ${failed.length} 个：\n${failed.join('\n')}`);
  else status(`已上传 ${files.length} 个文件`);
};
$('btn-sftp-download').onclick = async () => {
  if (!selectedSftpRow || selectedSftpRow.tabId !== activeTabId) { alert('请先选择一个文件。'); return; }
  const { entry, tabId } = selectedSftpRow;
  if (entry.attrs.mode & 0o040000) { alert('暂不支持直接下载目录。'); return; }
  const savePath = await api.saveFile(entry.filename);
  if (!savePath) return;
  try {
    await api.sftpDownload(tabId, remotePath(entry.filename), savePath);
    status(`已下载 ${entry.filename}`);
  } catch (err) { alert('下载失败：' + (err.message || String(err))); status('下载失败'); }
};
$('btn-sftp-delete').onclick = async () => {
  if (!selectedSftpRow || selectedSftpRow.tabId !== activeTabId) { alert('请先选择一个文件或目录。'); return; }
  const { entry, tabId } = selectedSftpRow;
  if (!confirm(`删除 ${entry.filename}？目录将被递归删除。`)) return;
  try {
    await api.sftpDelete(tabId, remotePath(entry.filename), !!(entry.attrs.mode & 0o040000));
    const t = tabs.get(tabId);
    if (t) loadSfptdirSafe(t, t.cwd);
    status(`已删除 ${entry.filename}`);
  } catch (err) { alert('删除失败：' + (err.message || String(err))); }
};

/* ---------------- 主密码设置 ---------------- */
async function openMasterModal() {
  $('master-modal').classList.remove('hidden');
  try {
    const st = await api.vaultStatus();
    $('master-status').textContent = st.configured
      ? `状态：已设置主密码（设置时间 ${st.updatedAt ? new Date(st.updatedAt).toLocaleString() : '未知'}）。修改后，用旧主密码加密的导出文件将无法还原密码。`
      : '状态：尚未设置主密码。设置后，导出会话时可用它加密密码。';
  } catch (_) { $('master-status').textContent = '状态：无法读取（preload 未就绪？）'; }
}

$('btn-master-save').onclick = async () => {
  const pw = $('mp-new').value;
  const confirm = $('mp-confirm').value;
  if (!pw || pw.length < 4) { alert('主密码至少 4 位。'); return; }
  if (pw !== confirm) { alert('两次输入的主密码不一致。'); return; }
  try {
    const r = await api.vaultSetMaster(pw);
    if (!r.ok) { alert('设置失败：' + (r.error || '未知错误')); return; }
    $('mp-new').value = ''; $('mp-confirm').value = '';
    alert('主密码已设置。请牢记：无法找回。');
    await openMasterModal();
  } catch (e) { alert('设置失败：' + (e.message || e)); }
};
$('btn-master-clear').onclick = async () => {
  if (!confirm('清除主密码后，将无法再解密此前导出的加密密码文件。确定清除？')) return;
  await api.vaultClearMaster();
  alert('主密码已清除。');
  await openMasterModal();
};

/* ---------------- Linux 命令查询 ---------------- */
let linuxReady = false;
function renderLinuxList() {
  const data = (window.LINUX_COMMANDS && window.LINUX_COMMANDS.commands) || [];
  const kw = ($('linux-search').value || '').trim().toLowerCase();
  const cat = $('linux-category').value;
  const list = data.filter((c) => {
    if (cat && c.category !== cat) return false;
    if (!kw) return true;
    return [c.cmd, c.name, c.desc, c.category, (c.tags || []).join(' ')]
      .join(' ').toLowerCase().includes(kw) ||
      (c.options || []).some((o) => (o.flag + o.desc).toLowerCase().includes(kw)) ||
      (c.examples || []).some((e) => (e.cmd + e.desc).toLowerCase().includes(kw));
  });
  $('linux-count').textContent = `共 ${list.length} 条`;
  const box = $('linux-list');
  box.textContent = '';
  if (!list.length) { box.innerHTML = '<div class="linux-empty">没有匹配的命令，换个关键词试试。</div>'; return; }
  list.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'linux-card';
    const head = document.createElement('div');
    head.className = 'linux-card-head';
    const name = document.createElement('span');
    name.className = 'linux-cmd';
    name.textContent = c.cmd;
    const title = document.createElement('span');
    title.className = 'linux-name';
    title.textContent = c.name;
    const tag = document.createElement('span');
    tag.className = 'linux-cat';
    tag.textContent = c.category;
    head.append(name, title, tag);
    const desc = document.createElement('div');
    desc.className = 'linux-desc';
    desc.textContent = c.desc;
    const usage = document.createElement('div');
    usage.className = 'linux-usage';
    usage.textContent = '语法：' + c.usage;
    card.append(head, desc, usage);
    if (c.options && c.options.length) {
      const ol = document.createElement('div');
      ol.className = 'linux-options';
      c.options.forEach((o) => {
        const row = document.createElement('div');
        const flag = document.createElement('code');
        flag.textContent = o.flag;
        const d = document.createElement('span');
        d.textContent = o.desc;
        row.append(flag, d);
        ol.appendChild(row);
      });
      card.appendChild(ol);
    }
    if (c.examples && c.examples.length) {
      const el = document.createElement('div');
      el.className = 'linux-examples';
      c.examples.forEach((ex) => {
        const row = document.createElement('div');
        const code = document.createElement('code');
        code.textContent = '$ ' + ex.cmd;
        const d = document.createElement('span');
        d.textContent = ex.desc;
        row.append(code, d);
        el.appendChild(row);
      });
      card.appendChild(el);
    }
    box.appendChild(card);
  });
}
function openLinuxModal() {
  if (!linuxReady) {
    const cats = (window.LINUX_COMMANDS && window.LINUX_COMMANDS.categories) || [];
    const sel = $('linux-category');
    cats.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    linuxReady = true;
  }
  $('linux-modal').classList.remove('hidden');
  renderLinuxList();
}
$('linux-search').oninput = renderLinuxList;
$('linux-category').onchange = renderLinuxList;

/* ---------------- 下发配置到交换机 ---------------- */
function openDeployModal() {
  const sel = $('deploy-session');
  sel.textContent = '';
  const sshSessions = getSessions().filter((s) => ['ssh', 'sftp'].includes(Fmt.normalizeProtocol(s.protocol)));
  if (!sshSessions.length) {
    const o = document.createElement('option'); o.value = ''; o.textContent = '（没有可用的 SSH 会话，请先新建）'; sel.appendChild(o);
  } else {
    sshSessions.forEach((s) => {
      const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.name} (${s.user}@${s.host}:${s.port})`; sel.appendChild(o);
    });
  }
  $('deploy-result').textContent = '';
  $('deploy-modal').classList.remove('hidden');
}
$('btn-deploy-do').onclick = async () => {
  const id = $('deploy-session').value;
  const text = $('deploy-text').value.trim();
  if (!id) { alert('请先选择目标 SSH 会话。'); return; }
  if (!text) { alert('请粘贴要下发的配置命令。'); return; }
  const session = getSessions().find((s) => s.id === id);
  if (!session) { alert('找不到目标会话。'); return; }
  if (!confirm(`即将把配置下发到 ${session.user}@${session.host}:${session.port} 并保存，确定继续？`)) return;
  $('deploy-result').textContent = '正在下发，请稍候…';
  status('正在下发配置到 ' + session.host);
  try {
    const commands = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('!'));
    const r = await api.deployConfig({ ...session, credentialId: session.credentialId || session.id }, commands);
    if (r.ok) {
      $('deploy-result').textContent = '下发完成。设备返回（末尾）：\n' + (r.output || '（无输出）');
      status('配置下发完成：' + session.host);
    } else {
      $('deploy-result').textContent = '下发失败：' + (r.error || '未知错误');
      status('配置下发失败');
    }
  } catch (e) { $('deploy-result').textContent = '下发失败：' + (e.message || e); status('配置下发失败'); }
};

window.addEventListener('resize', () => {
  tabs.forEach((t) => { try { t.fit.fit(); } catch {} });
});

/* 启动 */
if (!api || !Fmt || !Terminal || !FitAddon) {
  document.body.innerHTML = '<div style="padding:40px;color:#c00">安全层或终端组件未加载：请确认 preload.js、session-format.js 与 xterm 资源已正确安装。</div>';
} else {
  if (api.outputDirs) {
    Promise.resolve(api.outputDirs()).then((d) => {
      if (d && d.exports) {
        outputPaths = d;
        if ($('be-dir') && !$('be-dir').value) $('be-dir').value = d.exports;
      }
    }).catch(() => {});
  }
  renderSessions();
  applyPrefs();
}
