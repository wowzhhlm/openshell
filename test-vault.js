const assert = require('assert');
const V = require('./src/vault');

// 1. 基本加解密往返
const secrets = { 'host-a|22|root': { password: 'P@ssw0rd!', passphrase: '' }, 'host-b|22|admin': { password: 'secret123', passphrase: '' } };
const payload = V.encryptVault('MyMasterPass', secrets);
assert(payload.startsWith('OSNV1:'), '加密串格式标识');
const dec = V.decryptVault('MyMasterPass', payload);
assert(dec.ok === true, '正确主密码解密成功');
assert.deepStrictEqual(dec.secrets, secrets, '解密内容一致');

// 2. 错误主密码必须失败，且不泄露明文
const bad = V.decryptVault('WrongPass', payload);
assert(bad.ok === false, '错误主密码解密失败');
assert(!JSON.stringify(bad).includes('P@ssw0rd'), '错误解密不泄露明文');

// 3. 跨电脑场景：加密数据自带 salt，只依赖主密码（不依赖本地任何状态）
const payload2 = V.encryptVault('SameMaster', secrets);
assert.notStrictEqual(payload.split(':')[1], payload2.split(':')[1], '两次加密 salt 不同');
assert.deepStrictEqual(V.decryptVault('SameMaster', payload2).secrets, secrets, '同主密码可解密另一台电脑导出的密码');
assert(V.decryptVault('DifferentMaster', payload2).ok === false, '不同主密码无法解密');

// 4. 篡改检测（GCM 认证）
const parts = payload.split(':');
parts[4] = Buffer.from('tampered').toString('base64');
assert(V.decryptVault('MyMasterPass', parts.join(':')).ok === false, '篡改数据被拒绝');

// 5. 校验串：设置/验证主密码
const verifier = V.makeVerifier('MyMasterPass');
assert(V.checkVerifier('MyMasterPass', verifier) === true, '校验串验证正确密码');
assert(V.checkVerifier('Nope', verifier) === false, '校验串拒绝错误密码');

// 6. 空数据
assert.deepStrictEqual(V.decryptVault('x', V.encryptVault('x', {})).secrets, {}, '空字典往返');

console.log('VAULT_ALL_PASS');
