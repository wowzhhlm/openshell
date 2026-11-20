/* 验证：客户端显式算法列表能与"仅支持旧 kex 算法"的服务器握手成功 */
const { Server, Client, REQUIRE_TOKEN, utils } = require('ssh2');
const C = require('ssh2/lib/protocol/constants');
const net = require('net');

function uniq(l){return [...new Set(l.filter(Boolean))]}
const KEX_LIST = uniq([...(C.DEFAULT_KEX||[]), ...(C.SUPPORTED_KEX||[])]);
const CIPHER_LIST = uniq([...(C.DEFAULT_CIPHER||[]), ...(C.SUPPORTED_CIPHER||[])]);
const HOSTKEY_LIST = uniq([...(C.DEFAULT_SERVER_HOST_KEY||[]), ...(C.SUPPORTED_SERVER_HOST_KEY||[])]);

// 生成一个临时 RSA 主机密钥
const { generateKeyPairSync } = require('crypto');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });

const PORT = 23333;
const server = new Server({
  hostKeys: [privateKey],
  // 服务器只提供旧的 kex / cipher，模拟老设备
  kex: ['diffie-hellman-group14-sha1'],
  ciphers: ['aes128-cbc'],
  serverHostKey: ['ssh-rsa']
}, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'p') ctx.accept();
    else ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (accept) => accept());
      session.on('shell', (acceptShell) => {
        const stream = acceptShell();
        stream.write('LOGIN_OK\r\n');
        stream.exit(0); stream.end();
      });
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const conn = new Client();
  let gotData = false;
  conn.on('ready', () => {
    conn.shell((err, stream) => {
      if (err) { console.error('SHELL_ERR', err.message); conn.end(); server.close(); process.exit(1); }
      stream.on('data', (d) => { if (d.toString().includes('LOGIN_OK')) gotData = true; });
      stream.on('close', () => {
        setTimeout(() => {
          console.log('旧算法服务器握手+认证+shell:', gotData ? 'PASS' : 'FAIL');
          conn.end(); server.close(); process.exit(gotData ? 0 : 1);
        }, 200);
      });
    });
  });
  conn.on('error', (e) => {
    console.error('HANDSHAKE_FAIL:', e.message);
    server.close(); process.exit(1);
  });
  conn.connect({
    host: '127.0.0.1', port: PORT, username: 'u', password: 'p',
    readyTimeout: 8000,
    kex: KEX_LIST, ciphers: CIPHER_LIST, hmac: ['hmac-sha1','hmac-sha2-256'], serverHostKey: HOSTKEY_LIST
  });
});
