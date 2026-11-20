/* ftp.js — 轻量 FTP 客户端（基于 Node net，被动模式 PASV）
   仅实现文件传输所需的基础命令：登录、列目录、下载、上传、删除、切换目录。
   控制通道命令与响应为 ASCII；数据通道用 PASV。 */
'use strict';
const net = require('net');

function createFtpClient() {
  let sock = null;
  let buffer = '';
  let pending = null;      // 当前等待的响应解析器
  let dataListeners = [];
  const log = [];

  function readResponse() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('FTP 响应超时')); }, 30000);
      pending = {
        feed(line) {
          const code = parseInt(line.slice(0, 3), 10);
          if (code >= 400) { clearTimeout(timer); pending = null; reject(new Error(line)); return; }
          // 多行响应 xxx- ...  xxx 结束
          if (/^\d{3}-/.test(line)) return;
          clearTimeout(timer); pending = null; resolve(line);
        }
      };
      drain();
    });
  }

  function drain() {
    let idx;
    while (pending && (idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      log.push(line);
      try { pending.feed(line); } catch (_) {}
    }
  }

  // 消费连接时的 220 welcome 响应
  async function readWelcome() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('FTP 欢迎消息超时')); }, 30000);
      pending = {
        feed(line) {
          const code = parseInt(line.slice(0, 3), 10);
          if (code >= 400) { clearTimeout(timer); pending = null; reject(new Error(line)); return; }
          if (/^\d{3}-/.test(line)) return;
          clearTimeout(timer); pending = null; resolve(line);
        }
      };
      drain();
    });
  }

  function connect(host, port) {
    return new Promise((resolve, reject) => {
      sock = net.createConnection({ host, port: port || 21 });
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => { buffer += chunk; drain(); });
      sock.on('error', reject);
      sock.once('connect', () => resolve());
    });
  }

  async function cmd(line) {
    if (!sock) throw new Error('FTP 未连接');
    const p = readResponse();
    sock.write(line + '\r\n');
    return p;
  }

  async function auth(user, password) {
    await readWelcome();
    await cmd('USER ' + (user || 'anonymous'));
    const r = await cmd('PASS ' + (password || 'anonymous@'));
    return r;
  }

  async function pasv() {
    const r = await cmd('PASV');
    const m = r.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
    if (!m) throw new Error('无法解析 PASV 地址: ' + r);
    const host = m.slice(1, 5).join('.');
    const port = (parseInt(m[5], 10) << 8) + parseInt(m[6], 10);
    return { host, port };
  }

  function openData(host, port) {
    return new Promise((resolve, reject) => {
      const ds = net.createConnection({ host, port });
      ds.once('connect', () => resolve(ds));
      ds.once('error', reject);
    });
  }

  async function list(dir) {
    const { host, port } = await pasv();
    const ds = await openData(host, port);
    const chunks = [];
    ds.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => { ds.on('end', resolve); ds.on('close', resolve); });
    await cmd('TYPE A');
    await cmd('LIST ' + (dir || ''));
    await done;
    await readResponse(); // 226 transfer complete
    return Buffer.concat(chunks).toString('utf8');
  }

  async function download(remotePath) {
    const { host, port } = await pasv();
    const ds = await openData(host, port);
    const chunks = [];
    ds.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => { ds.on('end', resolve); ds.on('close', resolve); });
    await cmd('TYPE I');
    await cmd('RETR ' + remotePath);
    await done;
    await readResponse();
    return Buffer.concat(chunks);
  }

  async function upload(remotePath, dataBuffer) {
    const { host, port } = await pasv();
    const ds = await openData(host, port);
    await cmd('TYPE I');
    const storing = cmd('STOR ' + remotePath);
    ds.write(dataBuffer);
    ds.end();
    await storing;
    await readResponse();
  }

  async function cwd(dir) { return cmd('CWD ' + dir); }
  async function pwd() { return cmd('PWD'); }
  async function remove(path) { return cmd('DELE ' + path); }
  async function quit() { try { await cmd('QUIT'); } catch (_) {} close(); }
  function close() { try { sock && sock.destroy(); } catch (_) {} sock = null; }

  return { connect, auth, list, download, upload, cwd, pwd, remove, quit, close, getLog: () => log.slice() };
}

module.exports = { createFtpClient };
