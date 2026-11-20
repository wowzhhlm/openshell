/* test-kex.js — 严谨验证 SSH 算法兼容性修复
   关键点：ssh2 只读取 cfg.algorithms 对象里的算法列表（kex/cipher/serverHostKey/hmac），
   放到 cfg 顶层会被完全忽略。上轮测试误把算法放顶层，两端都用默认算法握手，是假阳性。

   本测试：
   - Server 用 algorithms 强制"只提供旧算法"（group14-sha1 + aes128-cbc + ssh-rsa + hmac-sha1）。
   - 对照组 A：Client 不传 algorithms（默认）→ 预期握手失败（no matching key exchange algorithm）。
   - 实验组 B：Client 传 main.js 修复后的 algorithms 全集 → 预期握手+认证+shell 成功。
   只有当 B 成功、A 失败，才证明"算法配置修复"真实生效。 */
const { Server, Client } = require('ssh2');
const C = require('ssh2/lib/protocol/constants');
const { generateKeyPairSync } = require('crypto');
const assert = require('assert');

function uniq(l) { return [...new Set(l.filter(Boolean))]; }
// 与 main.js 完全一致的算法列表构造（全部取自 ssh2 官方常量，100% 合法）
const KEX = uniq([...(C.DEFAULT_KEX || []), ...(C.SUPPORTED_KEX || [])]);
const CIPHER = uniq([...(C.DEFAULT_CIPHER || []), ...(C.SUPPORTED_CIPHER || [])]);
const HOSTKEY = uniq([...(C.DEFAULT_SERVER_HOST_KEY || []), ...(C.SUPPORTED_SERVER_HOST_KEY || [])]);
const HMAC = uniq([...(C.DEFAULT_MAC || []), ...(C.SUPPORTED_MAC || [])]);

// 断言：旧算法确实不在默认 kex 里，但在我们的列表里（否则测试无意义）
assert(!C.DEFAULT_KEX.includes('diffie-hellman-group14-sha1'), '默认 kex 不应含 group14-sha1');
assert(KEX.includes('diffie-hellman-group14-sha1'), '修复列表必须含 group14-sha1');
// 断言：我们列表里的算法名全部被 ssh2 认可（generateAlgorithmList 会逐项严格校验）
[C.SUPPORTED_KEX, C.SUPPORTED_CIPHER, C.SUPPORTED_SERVER_HOST_KEY, C.SUPPORTED_MAC]
  .forEach((supported, i) => {
    const list = [KEX, CIPHER, HOSTKEY, HMAC][i];
    list.forEach((a) => assert(supported.includes(a), '非法算法名会被 ssh2 抛错: ' + a));
  });
console.log('PASS: 算法列表全部合法且覆盖旧算法');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
});

const PORT = 23334;
// Server 通过 algorithms 强制只提供旧算法（注意键名是 cipher 单数）
const server = new Server({
  hostKeys: [privateKey],
  algorithms: {
    kex: ['diffie-hellman-group14-sha1'],
    cipher: ['aes128-cbc'],
    serverHostKey: ['ssh-rsa'],
    hmac: ['hmac-sha1']
  }
}, (client) => {
  // 对照组（默认算法）握手失败时 server 侧会抛 error，必须监听避免进程崩溃
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'p') ctx.accept();
    else ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (a) => a());
      session.on('shell', (a) => {
        const stream = a();
        stream.write('LOGIN_OK\r\n');
        stream.exit(0); stream.end();
      });
    });
  });
});

function tryConnect(useAlgorithms) {
  return new Promise((resolve) => {
    const conn = new Client();
    let done = false;
    const finish = (ok, detail) => { if (done) return; done = true; conn.end(); resolve({ ok, detail }); };
    conn.on('ready', () => {
      conn.shell((err, stream) => {
        if (err) return finish(false, err.message);
        let out = '';
        stream.on('data', (d) => { out += d.toString(); });
        stream.on('close', () => setTimeout(() => finish(out.includes('LOGIN_OK'), out.trim()), 100));
      });
    });
    conn.on('error', (e) => finish(false, e.message));
    const cfg = { host: '127.0.0.1', port: PORT, username: 'u', password: 'p', readyTimeout: 8000 };
    if (useAlgorithms) {
      cfg.algorithms = { kex: KEX, cipher: CIPHER, hmac: HMAC, serverHostKey: HOSTKEY };
    }
    try { conn.connect(cfg); } catch (e) { finish(false, 'connect 抛错: ' + e.message); }
    setTimeout(() => finish(false, '超时'), 9000);
  });
}

server.listen(PORT, '127.0.0.1', async () => {
  try {
    const a = await tryConnect(false); // 默认算法：应失败
    const b = await tryConnect(true);  // 修复后的 algorithms：应成功
    console.log('对照组(默认算法):', a.ok ? '意外成功' : '按预期失败 [' + a.detail + ']');
    console.log('实验组(修复算法):', b.ok ? '握手+认证+shell 成功' : '失败 [' + b.detail + ']');
    assert.strictEqual(a.ok, false, '默认算法应当无法与旧算法服务器握手（否则测试无效）');
    assert.strictEqual(b.ok, true, '修复后的 algorithms 必须能完成握手');
    console.log('KEX_ALL_PASS — 算法配置修复已真实生效');
    server.close(); process.exit(0);
  } catch (e) {
    console.error('KEX_TEST_FAIL:', e.message);
    server.close(); process.exit(1);
  }
});
