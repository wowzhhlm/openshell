/* 新功能单元测试：协议、保险库、密码导出格式、FTP 模块 */
const assert = require('assert');
const Fmt = require('./src/session-format');
const Vault = require('./src/vault');
const FTP = require('./src/ftp');

// --- 协议支持 ---
const expectProtocols = ['ssh', 'telnet', 'sftp', 'raw', 'rlogin', 'serial', 'local', 'ftp', 'rdp'];
expectProtocols.forEach((p) => assert(Fmt.PROTOCOLS.includes(p), '协议应包含 ' + p));
assert.strictEqual(Fmt.normalizeProtocol('RLOGIN'), 'rlogin');
assert.strictEqual(Fmt.normalizeProtocol('远程桌面'), 'rdp');
assert.strictEqual(Fmt.normalizeProtocol('本地终端'), 'local');
assert.strictEqual(Fmt.normalizeProtocol('串口'), 'serial');
assert.strictEqual(Fmt.defaultPort('rlogin'), 513);
assert.strictEqual(Fmt.defaultPort('ftp'), 21);
assert.strictEqual(Fmt.defaultPort('rdp'), 3389);
assert.strictEqual(Fmt.protocolName('rlogin'), 'Rlogin');
console.log('PASS: 9 种协议识别与默认端口');

// --- 密码保险库 ---
const secrets = { 's1': { password: 'p1' }, 's2': { password: 'p2', passphrase: 'pp' } };
const payload = Vault.encryptVault('master123', secrets);
assert(payload.startsWith('OSNV1:'));
assert.deepStrictEqual(Vault.decryptVault('master123', payload).secrets, secrets);
assert.strictEqual(Vault.decryptVault('wrong', payload).ok, false);
// 跨电脑：不同 salt 的同密码加密串都能解
const payload2 = Vault.encryptVault('master123', secrets);
assert.notStrictEqual(payload.split(':')[1], payload2.split(':')[1]);
assert.deepStrictEqual(Vault.decryptVault('master123', payload2).secrets, secrets);
console.log('PASS: 主密码加密与跨电脑解密');

// --- 会话格式：带保险库的导出/解析往返 ---
const sessions = [
  { id: 's1', name: 'A', host: '1.1.1.1', port: 22, user: 'root', protocol: 'rdp' },
  { id: 's2', name: 'B', host: '2.2.2.2', port: 513, user: 'admin', protocol: 'rlogin' }
];
const exported = Fmt.toOpenShell(sessions, payload);
const doc = JSON.parse(exported.content);
assert.strictEqual(doc.openshellVault, payload);
assert.strictEqual(doc.sessions.length, 2);
assert.strictEqual(doc.sessions[0].protocol, 'rdp');
assert.strictEqual(doc.sessions[1].protocol, 'rlogin');
assert.strictEqual(Fmt.guessFormat(exported.content, 'x.json'), 'openshell-vault');
const parsed = Fmt.parseFile({ text: exported.content, name: 'x.json' });
assert.strictEqual(parsed.format, 'openshell-vault');
assert.strictEqual(parsed.vault, payload);
assert.strictEqual(parsed.sessions.length, 2);
// 无密码导出仍是纯数组（兼容旧版）
const plain = Fmt.toOpenShell(sessions, '');
assert(Array.isArray(JSON.parse(plain.content)));
console.log('PASS: 密码保险库导出/解析往返');

// --- FTP 模块可实例化 ---
const c = FTP.createFtpClient();
['connect', 'auth', 'list', 'download', 'upload', 'remove', 'quit', 'close'].forEach((m) => assert.strictEqual(typeof c[m], 'function', 'FTP 方法 ' + m));
console.log('PASS: FTP 客户端接口');

// --- Linux 命令数据 ---
global.window = global;
require('./src/data/linux-commands');
assert(global.LINUX_COMMANDS.commands.length > 50);
assert(global.LINUX_COMMANDS.categories.length > 5);
console.log('PASS: Linux 命令库数据 ' + global.LINUX_COMMANDS.commands.length + ' 条');

console.log('FEATURES_ALL_PASS');
