const { app, BrowserWindow, ipcMain, dialog, session, safeStorage, shell, clipboard, Menu } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Client } = require('ssh2');
const SSH_CONST = require('ssh2/lib/protocol/constants');
const Vault = require('./vault');
const FTP = require('./ftp');

// 构建"现代优先 + 兼容旧设备"的算法列表：直接使用 ssh2 官方 SUPPORTED 全集，
// 把旧算法（group14-sha1 / group1-sha1 / cbc / 3des / ssh-rsa / ssh-dss）也纳入，
// 解决老服务器 "no matching key exchange algorithm / cipher / host key" 握手失败。
function uniq(list) { return [...new Set(list.filter(Boolean))]; }
const KEX_LIST = uniq([...(SSH_CONST.DEFAULT_KEX || []), ...(SSH_CONST.SUPPORTED_KEX || [])]);
const CIPHER_LIST = uniq([...(SSH_CONST.DEFAULT_CIPHER || []), ...(SSH_CONST.SUPPORTED_CIPHER || [])]);
const HOSTKEY_LIST = uniq([...(SSH_CONST.DEFAULT_SERVER_HOST_KEY || []), ...(SSH_CONST.SUPPORTED_SERVER_HOST_KEY || [])]);
const HMAC_LIST = [
  'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
  'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1', 'hmac-sha1-etm@openssh.com',
  'hmac-md5', 'hmac-md5-etm@openssh.com'
];

let mainWindow = null;
const tabs = new Map();

/* ---------------- 运行时路径 ----------------
   便携模式：exe 同级存在 portable.txt 时，所有数据与配置写入程序所在目录，
   因此整套目录复制到 U 盘后换电脑仍可正常使用（不依赖 D 盘）。
   普通模式：保持原有约定，统一写入 D:\openshell。                       */
let APP_DIR = 'D:\\openshell-network';
let PORTABLE_MODE = false;
try { APP_DIR = path.dirname(process.execPath); } catch {}
try { PORTABLE_MODE = fs.existsSync(path.join(APP_DIR, 'portable.txt')); } catch {}
const OUTPUT_ROOT = PORTABLE_MODE ? path.join(APP_DIR, 'OpenShell网络版数据') : 'D:\\openshell-network';
if (PORTABLE_MODE) {
  try { app.setPath('userData', path.join(OUTPUT_ROOT, '配置')); } catch {}
}

const CRED_FILE = () => path.join(app.getPath('userData'), 'credentials.json');
const HOSTS_FILE = () => path.join(app.getPath('userData'), 'known_hosts.json');
const MASTER_FILE = () => path.join(app.getPath('userData'), 'master-verifier.json');

const EXPORT_DIR = path.join(OUTPUT_ROOT, '导出');
const DOWNLOAD_DIR = path.join(OUTPUT_ROOT, '下载');
const REPORT_DIR = path.join(OUTPUT_ROOT, '报告');
const SESSION_EXTS = new Set(['.xsh', '.ini', '.json', '.xml', '.txt']);
const MAX_BATCH_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function ensureOutputDirs() {
  [OUTPUT_ROOT, EXPORT_DIR, DOWNLOAD_DIR, REPORT_DIR].forEach((d) => {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  });
}
ensureOutputDirs();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fsp.mkdir(path.dirname(file), { recursive: true })
    .then(() => fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8'))
    .catch(() => {});
}
function loadCreds() { return readJson(CRED_FILE(), {}); }
function loadHosts() { return readJson(HOSTS_FILE(), {}); }

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'OpenShell 网络版 - 多协议终端与网络拓扑配置工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    tabs.forEach((tab) => closeTabResources(tab));
    tabs.clear();
    mainWindow = null;
  });
}

function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.slice(2));
    for (let i = 0; i < swapped.length - 1; i += 2) {
      const tmp = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = tmp;
    }
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

/* ---------------- 窗口与对话框 ---------------- */
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:outputDirs', () => ({
  root: OUTPUT_ROOT, exports: EXPORT_DIR, downloads: DOWNLOAD_DIR, reports: REPORT_DIR,
  portable: PORTABLE_MODE, appDir: APP_DIR
}));
ipcMain.handle('app:openPath', async (_event, target) => {
  const dir = target === 'exports' ? EXPORT_DIR : target === 'downloads' ? DOWNLOAD_DIR : target === 'reports' ? REPORT_DIR : OUTPUT_ROOT;
  await shell.openPath(dir);
  return dir;
});

ipcMain.handle('dialog:selectPrivateKey', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择私钥文件',
    properties: ['openFile'],
    filters: [{ name: 'Private key', extensions: ['pem', 'key', 'ppk', 'txt'] }, { name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_event, suggestedName) => {
  const name = path.basename(String(suggestedName || 'download'));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存文件', defaultPath: path.join(DOWNLOAD_DIR, name)
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:selectImportFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入会话文件（支持多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '会话文件', extensions: ['xsh', 'ini', 'json', 'xml', 'xse'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled) return [];
  const files = [];
  for (const p of result.filePaths) {
    try {
      const buf = await fsp.readFile(p);
      files.push({ name: path.basename(p), text: decodeTextBuffer(buf), group: path.basename(path.dirname(p)) });
    } catch (e) {
      files.push({ name: path.basename(p), text: '', group: '', error: e.message });
    }
  }
  return files;
});

async function collectSessionFiles(rootDir) {
  const files = [];
  const skipped = [];
  async function walk(dir, depth) {
    if (files.length >= MAX_BATCH_FILES || depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { skipped.push({ path: dir, error: e.message }); return; }
    for (const entry of entries) {
      if (files.length >= MAX_BATCH_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && SESSION_EXTS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const st = await fsp.stat(full);
          if (st.size > MAX_FILE_BYTES) { skipped.push({ path: full, error: '文件超过 2MB，已跳过' }); continue; }
          const buf = await fsp.readFile(full);
          files.push({
            name: entry.name,
            text: decodeTextBuffer(buf),
            group: path.basename(path.dirname(full)) || '',
            sourcePath: full
          });
        } catch (e) { skipped.push({ path: full, error: e.message }); }
      }
    }
  }
  await walk(rootDir, 0);
  return { files, skipped };
}

ipcMain.handle('dialog:selectImportDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '批量导入：选择会话文件目录（递归扫描）',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { files: [], skipped: [], dir: null };
  const dir = result.filePaths[0];
  const { files, skipped } = await collectSessionFiles(dir);
  return { files, skipped, dir };
});

ipcMain.handle('dialog:selectExportDir', async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择导出目录', defaultPath: defaultPath || EXPORT_DIR,
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('clipboard:readText', () => clipboard.readText());
ipcMain.handle('clipboard:writeText', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('export:writeFiles', async (_event, dir, files) => {
  if (!dir || !Array.isArray(files)) return { count: 0, errors: [] };
  let count = 0;
  const errors = [];
  const root = path.resolve(dir);
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') continue;
    // 允许相对子目录（如 xshell/xxx.xsh），但拒绝越界路径
    const parts = f.name.split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
    if (!parts.length) continue;
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) {
      errors.push(f.name + ': 非法路径');
      continue;
    }
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, f.content, 'utf8');
      count++;
    } catch (e) { errors.push(f.name + ': ' + e.message); }
  }
  return { count, errors, dir };
});

/* ---------------- 主密码保险库 ----------------
   主密码校验串仅存本地；导出时用主密码把密码字典加密进会话文件，
   只有主密码相同的电脑才能解密还原密码。                       */
function loadMasterVerifier() { return readJson(MASTER_FILE(), null); }

ipcMain.handle('vault:status', () => {
  const v = loadMasterVerifier();
  return { configured: !!(v && v.verifier), updatedAt: v ? v.updatedAt : null };
});

ipcMain.handle('vault:setMaster', async (_event, password) => {
  const pw = String(password || '');
  if (pw.length < 4) return { ok: false, error: '主密码至少 4 位' };
  const verifier = Vault.makeVerifier(pw);
  writeJson(MASTER_FILE(), { verifier, updatedAt: new Date().toISOString() });
  return { ok: true };
});

ipcMain.handle('vault:verifyMaster', async (_event, password) => {
  const v = loadMasterVerifier();
  if (!v || !v.verifier) return { ok: false, error: '尚未设置主密码' };
  const ok = Vault.checkVerifier(String(password || ''), v.verifier);
  return { ok, error: ok ? '' : '主密码错误' };
});

ipcMain.handle('vault:encrypt', async (_event, password, secrets) => {
  try { return { ok: true, payload: Vault.encryptVault(String(password || ''), secrets || {}) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('vault:decrypt', async (_event, password, payload) => {
  const r = Vault.decryptVault(String(password || ''), payload);
  return r.ok ? { ok: true, secrets: r.secrets } : { ok: false, error: r.error };
});

ipcMain.handle('vault:clearMaster', async () => {
  try { await fsp.unlink(MASTER_FILE()); } catch {}
  return { ok: true };
});

/* ---------------- 凭据加密 ---------------- */
ipcMain.handle('cred:save', async (_event, id, password, passphrase) => {
  const key = String(id || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统未提供凭据加密能力' };
  const creds = loadCreds();
  const entry = {};
  if (password) entry.password = safeStorage.encryptString(String(password)).toString('base64');
  if (passphrase) entry.passphrase = safeStorage.encryptString(String(passphrase)).toString('base64');
  if (Object.keys(entry).length === 0) delete creds[key];
  else creds[key] = entry;
  writeJson(CRED_FILE(), creds);
  return { ok: true };
});

ipcMain.handle('cred:remove', async (_event, id) => {
  const creds = loadCreds();
  delete creds[String(id || '')];
  writeJson(CRED_FILE(), creds);
  return { ok: true };
});

/* 批量导出凭据明文（供主密码保险库加密；仅在渲染层主动请求时返回） */
ipcMain.handle('cred:exportAll', () => {
  const creds = loadCreds();
  const out = {};
  Object.entries(creds).forEach(([id, entry]) => {
    const item = {};
    try { if (entry.password) item.password = safeStorage.decryptString(Buffer.from(entry.password, 'base64')); } catch {}
    try { if (entry.passphrase) item.passphrase = safeStorage.decryptString(Buffer.from(entry.passphrase, 'base64')); } catch {}
    if (Object.keys(item).length) out[id] = item;
  });
  return out;
});

/* 批量导入凭据（解密后写回安全存储） */
ipcMain.handle('cred:importMany', async (_event, secrets) => {
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统未提供凭据加密能力', count: 0 };
  const creds = loadCreds();
  let count = 0;
  Object.entries(secrets || {}).forEach(([id, item]) => {
    if (!id || !item || typeof item !== 'object') return;
    const entry = {};
    try { if (item.password) entry.password = safeStorage.encryptString(String(item.password)).toString('base64'); } catch {}
    try { if (item.passphrase) entry.passphrase = safeStorage.encryptString(String(item.passphrase)).toString('base64'); } catch {}
    if (Object.keys(entry).length) { creds[id] = entry; count++; }
  });
  writeJson(CRED_FILE(), creds);
  return { ok: true, count };
});

function decryptCredential(id, field) {
  try {
    const entry = loadCreds()[String(id || '')];
    const value = entry && entry[field];
    if (!value) return '';
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch { return ''; }
}

/* ---------------- 主机密钥校验 ---------------- */
function fingerprint(hex) {
  const pairs = (String(hex || '').toUpperCase().match(/.{2}/g) || []);
  return 'SHA256:' + pairs.join(':');
}

async function verifyHostKey(hostAndPort, hex) {
  const hosts = loadHosts();
  const known = hosts[hostAndPort];
  if (known) return known === hex;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['信任并保存', '拒绝连接'],
    defaultId: 1,
    cancelId: 1,
    title: '首次连接：确认主机指纹',
    message: '无法确认主机身份，请通过可信渠道核对该指纹：\n\n' + hostAndPort + '\n' + fingerprint(hex) + '\n\n确认无误后方可继续。'
  });
  if (result.response !== 0) return false;
  hosts[hostAndPort] = hex;
  writeJson(HOSTS_FILE(), hosts);
  return true;
}

/* ---------------- 端口转发 ---------------- */
function applyForwarding(tab, rules) {
  (Array.isArray(rules) ? rules : []).forEach((rule) => {
    const local = Number(rule.local);
    const remote = Number(rule.remote);
    if (!local || local < 1 || local > 65535 || !remote || remote < 1 || remote > 65535 || !rule.host) return;
    try {
      const server = net.createServer((sock) => {
        tab.conn.forwardOut('127.0.0.1', 0, String(rule.host), remote, (err, upstream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(upstream).pipe(sock);
          upstream.on('error', () => sock.destroy());
          sock.on('error', () => upstream.destroy());
        });
      });
      server.on('error', (e) => send('ssh:forwardLog', tab.id, `转发 ${local} 失败: ${e.message}`));
      server.listen(local, '127.0.0.1', () => send('ssh:forwardLog', tab.id, `Local forwarding 127.0.0.1:${local} → ${rule.host}:${remote}`));
      tab.forwardServers.push(server);
    } catch (e) {
      send('ssh:forwardLog', tab.id, `转发规则无效: ${e.message}`);
    }
  });
}

function closeTabResources(tab) {
  tab.forwardServers.forEach((s) => { try { s.close(); } catch {} });
  tab.forwardServers = [];
  if (tab.sftp) { try { tab.sftp.end(); } catch {} tab.sftp = null; }
  if (tab.ftp) { try { tab.ftp.close(); } catch {} tab.ftp = null; }
  if (tab.localChild) { try { tab.localChild.kill(); } catch {} tab.localChild = null; }
  if (tab.stream) { try { tab.stream.end(); } catch {} tab.stream = null; }
  if (tab.conn) { try { tab.conn.end(); } catch {} tab.conn = null; }
}

/* ---------------- Telnet / 原始 TCP 连接 ---------------- */
function telnetParser(onData, replyOption) {
  let state = 0;
  let cmd = 0;
  let sub = [];
  return (chunk) => {
    const out = [];
    for (const b of chunk) {
      if (state === 0) {
        if (b === 255) state = 1; else out.push(b);
      } else if (state === 1) {
        if (b === 255) { out.push(255); state = 0; }
        else { cmd = b; state = (b === 250) ? 3 : 2; }
      } else if (state === 2) {
        if (cmd === 251 || cmd === 253) replyOption(255, 254, b);
        else if (cmd === 252 || cmd === 254) replyOption(255, 252, b);
        state = 0;
      } else if (state === 3) {
        if (b === 255) state = 4; else sub.push(b);
      } else if (state === 4) {
        if (b === 240) { state = 0; sub = []; }
        else if (b === 255) sub.push(255);
        else { sub = []; state = 3; }
      }
    }
    if (out.length) onData(Buffer.from(out));
  };
}

ipcMain.handle('telnet:connect', async (_event, tabId, session) => {
  if (!tabId || !session || !session.host) throw new Error('连接参数不完整');
  if (tabs.has(tabId)) closeTabResources(tabs.get(tabId));
  const tab = { id: tabId, conn: null, stream: null, sftp: null, forwardServers: [], session };
  tabs.set(tabId, tab);

  const isRaw = session.protocol === 'raw';
  const isRlogin = session.protocol === 'rlogin';
  const host = String(session.host);
  const port = Number(session.port) || (isRlogin ? 513 : 23);
  const credentialId = session.credentialId || session.id;
  const user = String(session.user || '');
  const password = decryptCredential(credentialId, 'password');
  let loginSent = false;
  let passSent = false;
  let tail = '';

  send('ssh:progress', tabId, `Connecting to ${host}:${port}...`);
  if (isRlogin) send('ssh:progress', tabId, 'RLOGIN 明文远程登录，正在建立连接…');
  else send('ssh:progress', tabId, isRaw ? '原始 TCP 连接建立中…' : 'Telnet 选项协商中，请等待远程提示…');
  const socket = net.createConnection({ host, port });
  tab.stream = socket;

  // RLOGIN 无 IAC 协商，就是明文透传；登录由首包固定格式完成
  const plainParse = (chunk) => send('ssh:data', tabId, chunk.toString('utf8'));
  const parse = (isRaw || isRlogin)
    ? plainParse
    : telnetParser(
      (buf) => {
        const text = buf.toString('utf8');
        tail = (tail + text).slice(-1024);
        if (!loginSent && user && /(?:login|username|用户(?:名)?)\s*[:：]\s*$/i.test(tail)) {
          socket.write(user + '\r\n');
          loginSent = true;
          send('ssh:progress', tabId, '已自动发送用户名，请按远程提示继续。');
        }
        if (loginSent && !passSent && password && /(?:password|口令|密码)\s*[:：]\s*$/i.test(tail)) {
          socket.write(password + '\r\n');
          passSent = true;
          send('ssh:progress', tabId, '已自动发送密码（Telnet 为明文协议，请注意网络安全）。');
        }
        send('ssh:data', tabId, text);
      },
      (...bytes) => { try { socket.write(Buffer.from(bytes)); } catch {} }
    );

  socket.on('connect', () => {
    if (isRlogin) {
      // RFC 1258：\0<local-user>\0<remote-user>\0<terminal>\0<speed>\0
      const localUser = user || process.env.USERNAME || process.env.USER || 'root';
      const term = 'xterm';
      const init = Buffer.from('\0' + localUser + '\0' + user + '\0' + term + '\09600\0', 'utf8');
      socket.write(init);
      send('ssh:progress', tabId, 'RLOGIN 登录请求已发送，连接已建立。');
    } else {
      send('ssh:progress', tabId, isRaw ? 'TCP 连接已建立，开始透传数据。' : 'Telnet 连接已建立。');
    }
    send('ssh:status', tabId, '已连接 ' + host + ':' + port);
  });
  socket.on('data', parse);
  socket.on('error', (err) => {
    send('ssh:error', tabId, err.message);
    send('ssh:status', tabId, '连接失败');
    try { socket.destroy(); } catch {}
    if (tabs.get(tabId) === tab) { tabs.delete(tabId); send('ssh:close', tabId); }
  });
  socket.on('close', () => {
    send('ssh:progress', tabId, '\x1b[2m[连接已关闭]\x1b[0m');
    if (tabs.get(tabId) === tab) send('ssh:close', tabId);
  });
  return { ok: true };
});

/* ---------------- SSH 连接 ---------------- */
ipcMain.handle('ssh:connect', async (_event, tabId, session) => {
  if (!tabId || !session || !session.host) throw new Error('连接参数不完整');
  if (tabs.has(tabId)) closeTabResources(tabs.get(tabId));
  const tab = { id: tabId, conn: null, stream: null, sftp: null, forwardServers: [], session };
  tabs.set(tabId, tab);

  const cfg = {
    host: String(session.host),
    port: Number(session.port) || 22,
    username: String(session.user || ''),
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    hostHash: 'sha256',
    // 显式声明算法列表：默认安全算法在前优先协商，兼容旧设备的算法在后兜底，
    // 解决 "no matching key exchange algorithm" / "no matching cipher" 握手失败。
    kex: KEX_LIST,
    ciphers: CIPHER_LIST,
    hmac: HMAC_LIST,
    serverHostKey: HOSTKEY_LIST,
    hostVerifier: (hex, callback) => {
      send('ssh:progress', tabId, '正在验证主机密钥…');
      verifyHostKey(cfg.host + ':' + cfg.port, hex).then((ok) => {
        if (ok) send('ssh:progress', tabId, '主机密钥已确认 ' + fingerprint(hex));
        else {
          send('ssh:progress', tabId, '\x1b[31m主机密钥未确认，已拒绝连接\x1b[0m');
          send('ssh:status', tabId, '已拒绝：主机指纹未确认');
        }
        callback(ok);
      }).catch(() => callback(false));
    }
  };

  const credentialId = session.credentialId || session.id;
  if (session.auth === 'privatekey') {
    try {
      const keyPath = String(session.keyfile || '');
      if (!keyPath) throw new Error('未指定私钥文件');
      cfg.privateKey = await fsp.readFile(keyPath);
      const passphrase = decryptCredential(credentialId, 'passphrase');
      if (passphrase) cfg.passphrase = passphrase;
    } catch (e) {
      send('ssh:error', tabId, '读取私钥失败: ' + e.message);
      send('ssh:status', tabId, '连接失败');
      return { ok: false, error: e.message };
    }
  } else {
    cfg.password = decryptCredential(credentialId, 'password');
  }

  const conn = new Client();
  tab.conn = conn;
  send('ssh:progress', tabId, `Connecting to ${cfg.host}:${cfg.port}...`);
  conn.on('handshake', () => {
    send('ssh:progress', tabId, 'SSH 握手完成，正在认证…');
  });
  conn.on('ready', () => {
    send('ssh:progress', tabId, '认证成功，正在打开终端…');
    send('ssh:status', tabId, '已连接 ' + cfg.host);
    if (session.protocol === 'sftp') {
      send('ssh:progress', tabId, 'SFTP 文件传输模式已就绪。');
      conn.sftp((sftpErr, sftp) => {
        if (sftpErr) {
          send('ssh:error', tabId, 'SFTP 初始化失败: ' + sftpErr.message);
          return;
        }
        tab.sftp = sftp;
        send('ssh:status', tabId, '已连接 ' + cfg.host + '（SFTP 可用）');
      });
      return;
    }
    conn.shell((err, stream) => {
      if (err) {
        send('ssh:error', tabId, 'Shell 打开失败: ' + err.message);
        return;
      }
      tab.stream = stream;
      stream.on('data', (data) => send('ssh:data', tabId, data.toString('utf8')));
      stream.stderr.on('data', (data) => send('ssh:data', tabId, data.toString('utf8')));
      stream.on('close', () => {
        send('ssh:data', tabId, '\r\n[Connection closed]');
        send('ssh:close', tabId);
      });
      stream.setWindow(24, 80, 0, 0);
      applyForwarding(tab, session.forwardRules);
      conn.sftp((sftpErr, sftp) => {
        if (sftpErr) return;
        tab.sftp = sftp;
        send('ssh:status', tabId, '已连接 ' + cfg.host + '（SFTP 可用）');
      });
    });
  });
  conn.on('error', (err) => {
    send('ssh:error', tabId, err.message);
    send('ssh:status', tabId, '连接失败');
  });
  conn.on('close', () => {
    send('ssh:progress', tabId, '\x1b[2m[Connection closed]\x1b[0m');
    tab.forwardServers.forEach((s) => { try { s.close(); } catch {} });
    tab.forwardServers = [];
    if (tabs.get(tabId) === tab) send('ssh:close', tabId);
  });
  conn.connect(cfg);
  return { ok: true };
});

ipcMain.on('ssh:write', (_event, tabId, data) => {
  const tab = tabs.get(tabId);
  if (tab && tab.stream && typeof data === 'string') tab.stream.write(data);
});

ipcMain.on('ssh:resize', (_event, tabId, cols, rows) => {
  const tab = tabs.get(tabId);
  if (tab && tab.stream && cols > 0 && rows > 0) {
    try { tab.stream.setWindow(rows, cols, 0, 0); } catch {}
  }
});

ipcMain.on('ssh:disconnect', (_event, tabId) => {
  const tab = tabs.get(tabId);
  if (tab) { closeTabResources(tab); tabs.delete(tabId); }
});

/* ---------------- SFTP ---------------- */
function getSftp(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.sftp) throw new Error('当前标签没有 SFTP 会话');
  return tab;
}

ipcMain.handle('sftp:readdir', async (_event, tabId, dir) => {
  const tab = getSftp(tabId);
  return new Promise((resolve, reject) => {
    tab.sftp.readdir(String(dir || '.'), (err, list) => {
      if (err) return reject(new Error(err.message));
      resolve((list || []).map((e) => ({
        filename: e.filename,
        longname: e.longname || '',
        attrs: { mode: e.attrs.mode || 0, size: e.attrs.size || 0, mtime: e.attrs.mtime || 0 }
      })));
    });
  });
});

ipcMain.handle('sftp:upload', async (_event, tabId, localPath, remotePath) => {
  const tab = getSftp(tabId);
  if (!localPath || !remotePath) throw new Error('路径参数不完整');
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(localPath);
    const ws = tab.sftp.createWriteStream(remotePath);
    let sent = 0;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      rs.destroy(); ws.destroy();
      reject(new Error(e && e.message ? e.message : '上传失败'));
    };
    rs.on('data', (chunk) => {
      sent += chunk.length;
      send('sftp:progress', tabId, path.basename(localPath), sent, -1);
    });
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('close', () => { if (!settled) { settled = true; resolve({ ok: true, bytes: sent }); } });
    rs.pipe(ws);
  });
});

ipcMain.handle('sftp:download', async (_event, tabId, remotePath, localPath) => {
  const tab = getSftp(tabId);
  if (!remotePath || !localPath) throw new Error('路径参数不完整');
  return new Promise((resolve, reject) => {
    const rs = tab.sftp.createReadStream(remotePath);
    const ws = fs.createWriteStream(localPath);
    let received = 0;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      rs.destroy(); ws.destroy();
      reject(new Error(e && e.message ? e.message : '下载失败'));
    };
    rs.on('data', (chunk) => {
      received += chunk.length;
      send('sftp:progress', tabId, path.basename(remotePath), received, -1);
    });
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('close', () => { if (!settled) { settled = true; resolve({ ok: true, bytes: received }); } });
    rs.pipe(ws);
  });
});

function sftpRemove(sftp, remotePath, isDir) {
  return new Promise((resolve, reject) => {
    if (!isDir) {
      sftp.unlink(remotePath, (err) => err ? reject(new Error(err.message)) : resolve());
      return;
    }
    sftp.readdir(remotePath, (err, list) => {
      if (err) return reject(new Error(err.message));
      const items = (list || []).filter((e) => e.filename !== '.' && e.filename !== '..');
      let index = 0;
      const next = () => {
        if (index >= items.length) {
          sftp.rmdir(remotePath, (e) => e ? reject(new Error(e.message)) : resolve());
          return;
        }
        const item = items[index++];
        const child = remotePath.replace(/\/$/, '') + '/' + item.filename;
        const childIsDir = !!(item.attrs && item.attrs.mode && (item.attrs.mode & 0o040000));
        sftpRemove(sftp, child, childIsDir).then(next).catch(reject);
      };
      next();
    });
  });
}

ipcMain.handle('sftp:delete', async (_event, tabId, remotePath, isDir) => {
  const tab = getSftp(tabId);
  await sftpRemove(tab.sftp, String(remotePath), !!isDir);
  return { ok: true };
});

let topologyWindow = null;
function openTopologyWindow() {
  if (topologyWindow && !topologyWindow.isDestroyed()) {
    topologyWindow.focus();
    return;
  }
  topologyWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    title: 'OpenShell 网络版 · 网络拓扑配置工具',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  });
  topologyWindow.loadFile(path.join(__dirname, 'topology', 'index.html'));
  topologyWindow.on('closed', () => { topologyWindow = null; });
}

ipcMain.handle('topology:open', () => { openTopologyWindow(); return { ok: true }; });

/* ---------------- 本地终端 (local) ---------------- */
let localSeq = 0;
ipcMain.handle('local:spawn', async (_event, tabId) => {
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash';
  let child;
  try {
    child = spawn(shell, [], { cwd: OUTPUT_ROOT, env: { ...process.env }, windowsHide: true });
  } catch (e) { throw new Error('启动本地终端失败: ' + e.message); }
  const id = 'local-' + (++localSeq);
  const tab = { id: tabId, localChild: child, session: { protocol: 'local' } };
  tabs.set(tabId, tab);
  child.stdout.on('data', (b) => send('ssh:data', tabId, decodeTextBuffer(b)));
  child.stderr.on('data', (b) => send('ssh:data', tabId, decodeTextBuffer(b)));
  child.on('close', (code) => {
    send('ssh:data', tabId, `\r\n\x1b[2m[本地终端已退出，代码 ${code}]\x1b[0m\r\n`);
    send('ssh:close', tabId);
    tabs.delete(tabId);
  });
  child.on('error', (e) => send('ssh:error', tabId, e.message));
  send('ssh:progress', tabId, `本地终端已启动：${path.basename(shell)}`);
  return { ok: true };
});

ipcMain.on('local:write', (_event, tabId, data) => {
  const tab = tabs.get(tabId);
  if (tab && tab.localChild && tab.localChild.stdin) tab.localChild.stdin.write(data);
});

/* ---------------- RDP：调用系统远程桌面客户端 ---------------- */
/* ---------------- FTP 文件传输 ---------------- */
ipcMain.handle('ftp:connect', async (_event, tabId, session) => {
  if (!tabId || !session || !session.host) throw new Error('FTP 连接参数不完整');
  const client = FTP.createFtpClient();
  try {
    await client.connect(String(session.host), Number(session.port) || 21);
    await client.auth(String(session.user || 'anonymous'), decryptCredential(session.credentialId || session.id, 'password') || 'anonymous@');
    const tab = { id: tabId, ftp: client, session, forwardServers: [] };
    tabs.set(tabId, tab);
    send('ssh:progress', tabId, `FTP 已连接 ${session.host}`);
    send('ssh:status', tabId, 'FTP 已连接 ' + session.host);
    return { ok: true };
  } catch (e) { client.close(); throw e; }
});
ipcMain.handle('ftp:list', async (_event, tabId, dir) => {
  const tab = tabs.get(tabId);
  if (!tab || !tab.ftp) throw new Error('当前标签没有 FTP 连接');
  return tab.ftp.list(dir);
});
ipcMain.handle('ftp:download', async (_event, tabId, remotePath, localPath) => {
  const tab = tabs.get(tabId);
  if (!tab || !tab.ftp) throw new Error('当前标签没有 FTP 连接');
  const buf = await tab.ftp.download(remotePath);
  await fsp.writeFile(localPath, buf);
  return { ok: true, size: buf.length };
});
ipcMain.handle('ftp:delete', async (_event, tabId, remotePath) => {
  const tab = tabs.get(tabId);
  if (!tab || !tab.ftp) throw new Error('当前标签没有 FTP 连接');
  await tab.ftp.remove(remotePath);
  return { ok: true };
});
ipcMain.on('ftp:close', (_event, tabId) => {
  const tab = tabs.get(tabId);
  if (tab && tab.ftp) tab.ftp.close();
  if (tabs.get(tabId) === tab) tabs.delete(tabId);
});

ipcMain.handle('rdp:launch', async (_event, session) => {
  const host = String(session.host || '').trim();
  const port = Number(session.port) || 3389;
  if (!host) return { ok: false, error: '请填写主机地址' };
  if (process.platform !== 'win32') return { ok: false, error: 'RDP 一键启动仅支持 Windows，请手动使用远程桌面客户端连接 ' + host + ':' + port };
  const target = port === 3389 ? host : `${host}:${port}`;
  // 优先用 mstsc 图形客户端；RDP 是图形协议，无法在终端内渲染
  spawn('mstsc', ['/v:' + target], { detached: true, windowsHide: false, stdio: 'ignore' }).on('error', () => {});
  return { ok: true, message: '已启动系统远程桌面连接：' + target };
});

ipcMain.handle('net:deployConfig', async (_event, session, commands) => {
  // 复用 SSH 连接，把生成的交换机配置逐条下发（system-view 批量粘贴）
  const cfg = {
    host: String(session.host || ''),
    port: Number(session.port) || 22,
    username: String(session.user || ''),
    password: decryptCredential(session.credentialId || session.id, 'password'),
    privateKey: session.keyfile ? (() => { try { return fs.readFileSync(session.keyfile); } catch { return undefined; } })() : undefined,
    passphrase: decryptCredential(session.credentialId || session.id, 'passphrase') || undefined,
    readyTimeout: 20000
  };
  if (!cfg.host) return { ok: false, error: '目标交换机主机不能为空' };
  const text = Array.isArray(commands) ? commands.join('\n') : String(commands || '');
  return await new Promise((resolve) => {
    const conn = new Client();
    const logs = [];
    conn.on('ready', () => {
      conn.shell((err, stream) => {
        if (err) { conn.end(); return resolve({ ok: false, error: err.message, logs }); }
        let buf = '';
        stream.on('data', (d) => { buf += decodeTextBuffer(d); });
        stream.stderr.on('data', (d) => { buf += decodeTextBuffer(d); });
        setTimeout(() => {
          stream.write(text + '\nreturn\nsave\ny\n');
          setTimeout(() => {
            const out = buf.slice(-4000);
            stream.end('exit\n');
            conn.end();
            resolve({ ok: true, output: out, logs });
          }, 3500);
        }, 500);
      });
    });
    conn.on('error', (e) => resolve({ ok: false, error: e.message, logs }));
    try { conn.connect(cfg); } catch (e) { resolve({ ok: false, error: e.message, logs }); }
  });
});

/* ---------------- 生命周期 ---------------- */
function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'serial');
  });
}

app.whenReady().then(() => {
  // 禁用 Electron 默认原生菜单（File/Edit/View/Window/Help），界面只保留自绘的中文菜单
  Menu.setApplicationMenu(null);
  configurePermissions();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { tabs.forEach((tab) => closeTabResources(tab)); tabs.clear(); });
