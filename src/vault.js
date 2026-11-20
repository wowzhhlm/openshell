/* vault.js — 基于主密码的会话密码保险库
   设计要点：
   1. 主密码经 scrypt 派生 32 字节密钥，salt 随机生成。
   2. 导出时把 salt + iv + authTag + 密文一并打包成字符串；只要两台电脑主密码相同，
      用数据自带的 salt 即可派生相同密钥并解密 —— 满足"主密码相同才导入密码"。
   3. AES-256-GCM 认证加密，密码错误或数据被篡改时解密失败，绝不会返回错误明文。
   4. 提供"清除密码"选项：导出时不写密码字段，从源头避免密码泄露。       */
'use strict';
const crypto = require('crypto');

const MAGIC = 'OSNV1';              // 格式标识 + 版本
const SCRYPT_N = 16384;
const KDF_LEN = 32;

function deriveKey(masterPassword, salt) {
  return crypto.scryptSync(String(masterPassword), salt, KDF_LEN, { N: SCRYPT_N, r: 8, p: 1 });
}

/* 加密密码字典：{ [sessionKey]: {password, passphrase} } -> 加密串 */
function encryptVault(masterPassword, secretMap) {
  if (!masterPassword) throw new Error('主密码不能为空');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(masterPassword, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(secretMap || {}), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    MAGIC,
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64')
  ].join(':');
}

/* 解密加密串 -> 密码字典；密码错误/数据损坏返回 { ok:false, error } */
function decryptVault(masterPassword, payload) {
  if (!masterPassword) return { ok: false, error: '请输入主密码' };
  try {
    const parts = String(payload || '').split(':');
    if (parts.length !== 5 || parts[0] !== MAGIC) return { ok: false, error: '不是有效的加密密码数据' };
    const salt = Buffer.from(parts[1], 'base64');
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const enc = Buffer.from(parts[4], 'base64');
    const key = deriveKey(masterPassword, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const map = JSON.parse(dec.toString('utf8'));
    return { ok: true, secrets: map };
  } catch (_) {
    return { ok: false, error: '主密码错误，或加密数据已损坏' };
  }
}

/* 主密码校验：用固定明文生成校验串，存到本地用于判断用户后续输入是否正确 */
function makeVerifier(masterPassword) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(masterPassword, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from('openshell-master-verify')), cipher.final()]);
  return [MAGIC, salt.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function checkVerifier(masterPassword, payload) {
  if (!masterPassword) return false;
  try {
    const parts = String(payload || '').split(':');
    if (parts.length !== 5 || parts[0] !== MAGIC) return false;
    const salt = Buffer.from(parts[1], 'base64');
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const enc = Buffer.from(parts[4], 'base64');
    const key = deriveKey(masterPassword, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8') === 'openshell-master-verify';
  } catch (_) { return false; }
}

module.exports = { encryptVault, decryptVault, makeVerifier, checkVerifier, MAGIC };
