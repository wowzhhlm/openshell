(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const safe = (v) => String(v == null ? '' : v).trim();
  const PROTOCOLS = ['ssh', 'telnet', 'sftp', 'raw', 'rlogin', 'serial', 'local', 'ftp', 'rdp'];

  function protocolFrom(value) {
    const v = safe(value).toLowerCase();
    if (/rlogin|r-login/.test(v)) return 'rlogin';
    if (/telnet/.test(v) || v === '2' || v === '23') return 'telnet';
    if (/sftp/.test(v) || v === '5') return 'sftp';
    if (/ftp/.test(v)) return 'ftp';
    if (/serial|com口|串口/.test(v)) return 'serial';
    if (/local|shell|本地/.test(v)) return 'local';
    if (/rdp|remote desktop|远程桌面/.test(v)) return 'rdp';
    if (/raw|tcp/.test(v)) return 'raw';
    return 'ssh';
  }
  function protocolNumber(p) {
    return ({ telnet: '2', sftp: '5', rlogin: '3', ftp: '4', raw: '6', serial: '7', local: '8', rdp: '9' })[p] || '1';
  }
  function protocolName(p) {
    return ({ telnet: 'Telnet', sftp: 'SFTP', rlogin: 'Rlogin', ftp: 'FTP', raw: 'RAW', serial: 'Serial', local: 'Local', rdp: 'RDP' })[p] || 'SSH2';
  }
  function defaultPort(p) {
    return ({ telnet: 23, rlogin: 513, ftp: 21, rdp: 3389 })[p] || 22;
  }
  function normalizeProtocol(p) {
    const v = protocolFrom(p);
    return PROTOCOLS.includes(v) ? v : 'ssh';
  }

  function guessFormat(text, fileName) {
    const t = text || '';
    const name = (fileName || '').toLowerCase();
    if (/^\s*\{|^\s*\[\s*\{/.test(t)) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return 'openshell';
        if (parsed && (parsed.openshellVault || Array.isArray(parsed.sessions))) return 'openshell-vault';
      } catch (_) { /* fall through */ }
    }
    if (/<Session[\s>]/.test(t) || /<\?xml/i.test(t)) return 'xshell-xml';
    if (/S\s*:\s*"Hostname"|\[S:/i.test(t)) return 'securecrt';
    if (/\[Connection\]|\[SSH\]|\[Session\]/i.test(t) || /^\s*(Host|Port|UserName|AuthMethod)\s*=/im.test(t)) return 'xshell-ini';
    if (name.endsWith('.xsh')) return 'xshell-ini';
    if (name.endsWith('.ini')) return 'securecrt';
    return 'unknown';
  }

  function parseIni(text) {
    const out = {};
    let section = '';
    (text || '').split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line || /^[;#]/.test(line)) return;
      const sec = line.match(/^\[([^\]]+)\]$/);
      if (sec) { section = sec[1].trim(); return; }
      const eq = line.indexOf('=');
      if (eq < 0) return;
      let key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      key = key.replace(/^[SDB]:\s*/, '').replace(/^"|"$/g, '');
      out[section + '|' + key.toLowerCase()] = value;
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  function pick(map, keys) {
    for (const k of keys) {
      const v = map[k.toLowerCase()];
      if (v != null && safe(v)) return safe(v);
    }
    return '';
  }

  function authFrom(value, keyFile) {
    const v = safe(value).toLowerCase();
    if (/public|key|2/.test(v) || keyFile) return 'privatekey';
    return 'password';
  }

  function parseXshellIni(text, fileName, groupHint) {
    const m = parseIni(text);
    const host = pick(m, ['connection|host', 'session|host', 'host', 'connection|hostname', 'hostname']);
    if (!host) return null;
    const protocol = normalizeProtocol(pick(m, ['connection|protocol', 'session|protocol', 'protocol']));
    const portDefault = defaultPort(protocol);
    const port = parseInt(pick(m, ['connection|port', 'session|port', 'port']) || String(portDefault), 10) || portDefault;
    const user = pick(m, ['ssh|user', 'session|username', 'ssh|username', 'user', 'username', 'login', 'telnet|user']);
    const name = pick(m, ['connection|name', 'session|name', 'name']) ||
      (fileName || '').replace(/\.xsh$/i, '') || host;
    const keyFile = pick(m, ['ssh|keyfile', 'ssh|userkeyfile', 'ssh|publickeyfile', 'keyfile', 'userkeyfile', 'publickeyfile']);
    const authMethod = pick(m, ['ssh|authmethod', 'authmethod', 'ssh|authenticationmethod']);
    return [{
      name, group: groupHint || '', host, port, user, protocol,
      auth: authFrom(authMethod, keyFile),
      keyfile: keyFile, password: '', passphrase: '', needsCredential: true
    }];
  }

  function xmlText(block, tags) {
    for (const tag of tags) {
      const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
      if (m && safe(m[1])) return safe(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    }
    return '';
  }

  function parseXshellXml(text, fileName, groupHint) {
    const blocks = (String(text || '').match(/<Session(?:\s[^>]*)?>[\s\S]*?<\/Session>/gi) || []);
    const sources = blocks.length ? blocks : (String(text || '').trim() ? [String(text)] : []);
    const sessions = [];
    sources.forEach((block) => {
      const host = xmlText(block, ['Host', 'Address', 'HostName']);
      if (!host) return;
      const keyFile = xmlText(block, ['KeyFile', 'UserKeyFile', 'PublicKeyFile']);
      const protocol = normalizeProtocol(xmlText(block, ['Protocol', 'ProtocolName']));
      const portDefault = defaultPort(protocol);
      const nameAttr = block.match(/<Session[^>]*\bname\s*=\s*"([^"]*)"/i);
      sessions.push({
        name: xmlText(block, ['Name', 'SessionName']) || (nameAttr && safe(nameAttr[1])) ||
          (fileName || '').replace(/\.xsh$/i, '') || host,
        group: groupHint || '',
        host,
        port: parseInt(xmlText(block, ['Port']) || String(portDefault), 10) || portDefault,
        user: xmlText(block, ['UserName', 'User']),
        protocol,
        auth: authFrom(xmlText(block, ['AuthMethod', 'AuthenticationMethod']), keyFile),
        keyfile: keyFile, password: '', passphrase: '', needsCredential: true
      });
    });
    return sessions.length ? sessions : null;
  }

  function parseSecureCrt(text, fileName, groupHint) {
    const m = parseIni(text);
    const host = pick(m, ['hostname', 's:hostname']);
    if (!host) return null;
    const protocolRaw = pick(m, ['protocol name', 'protocol']);
    const protocol = normalizeProtocol(protocolRaw || 'ssh2');
    if (protocolRaw && !/ssh|telnet|sftp|raw|tcp/i.test(protocolRaw)) return null;
    const portRaw = pick(m, [
      '[ssh2] port', '[telnet] port', '[sftp] port', 'port',
      's:[ssh2] port', 's:[telnet] port', 's:[sftp] port'
    ]);
    let port = defaultPort(protocol);
    if (portRaw) {
      port = /^\d+$/.test(portRaw) && portRaw.length <= 5 ? parseInt(portRaw, 10) : parseInt(portRaw, 16);
      if (!port || port < 1 || port > 65535) port = defaultPort(protocol);
    }
    const user = pick(m, ['username', 's:username']);
    const name = pick(m, ['session name', 's:session name']) ||
      (fileName || '').replace(/\.ini$/i, '') || host;
    const keyFile = pick(m, ['[ssh2] public key file', 'public key file', 'identity file', 'keyfile']);
    const authRaw = pick(m, ['[ssh2] auth', 'ssh2 authentications v2', 'authentication']);
    let auth = authFrom(authRaw, keyFile);
    if (/publickey/i.test(authRaw)) auth = 'privatekey';
    return [{
      name, group: groupHint || '', host, port, user, protocol,
      auth, keyfile: keyFile, password: '', passphrase: '', needsCredential: true
    }];
  }

  function normalizeSession(s) {
    return {
      id: safe(s.id) || ('s-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8)),
      name: safe(s.name) || safe(s.host),
      group: safe(s.group),
      host: safe(s.host),
      port: parseInt(s.port, 10) || defaultPort(normalizeProtocol(s.protocol)),
      user: safe(s.user),
      protocol: normalizeProtocol(s.protocol),
      auth: s.auth === 'privatekey' ? 'privatekey' : 'password',
      password: '', passphrase: '',
      keyfile: safe(s.keyfile),
      needsCredential: true,
      credentialId: safe(s.credentialId) || safe(s.id) || ''
    };
  }

  function parseOpenSsh(text) {
    const parsed = JSON.parse(text);
    // 支持三种：纯数组 / {sessions:[...]} / {openshellVault, sessions:[...]}
    let list = parsed;
    if (parsed && !Array.isArray(parsed)) list = Array.isArray(parsed.sessions) ? parsed.sessions : null;
    if (!Array.isArray(list)) throw new Error('会话文件格式错误：期望 JSON 数组或带 sessions 的对象');
    return list.filter((s) => s && typeof s === 'object' && safe(s.host)).map(normalizeSession);
  }

  /* 读取带保险库的文件，返回 { sessions, vault } */
  function parseOpenSshVault(text) {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return {
      sessions: list.filter((s) => s && typeof s === 'object' && safe(s.host)).map(normalizeSession),
      vault: safe(parsed.openshellVault)
    };
  }

  function parseFile(file) {
    const text = file.text || '';
    const fileName = file.name || '';
    const format = guessFormat(text, fileName);
    let sessions = null;
    let vault = '';
    if (format === 'openshell') sessions = parseOpenSsh(text);
    else if (format === 'openshell-vault') {
      const parsed = parseOpenSshVault(text);
      sessions = parsed.sessions;
      vault = parsed.vault;
    }
    else if (format === 'xshell-xml') sessions = parseXshellXml(text, fileName, file.group);
    else if (format === 'xshell-ini') sessions = parseXshellIni(text, fileName, file.group);
    else if (format === 'securecrt') sessions = parseSecureCrt(text, fileName, file.group);
    return { format, sessions: sessions || [], vault };
  }

  function safeName(name) {
    return safe(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 80) || 'session';
  }

  function toXshell(session) {
    const protocol = normalizeProtocol(session.protocol);
    const lines = [
      '[Connection]',
      'Name=' + safeName(session.name),
      'Host=' + safe(session.host),
      'Port=' + (parseInt(session.port, 10) || defaultPort(protocol)),
      'Protocol=' + protocolNumber(protocol),
      '',
      '[SSH]',
      'User=' + safe(session.user),
      'AuthMethod=' + (session.auth === 'privatekey' ? 'PublicKey' : 'Password'),
      'Password=',
      'KeyFile=' + safe(session.keyfile),
      '',
      '[Display]',
      'TerminalType=xterm',
      'Charset=UTF-8',
      ''
    ];
    return { name: safeName(session.name) + '.xsh', content: lines.join('\r\n') };
  }

  function toSecureCrt(session) {
    const protocol = normalizeProtocol(session.protocol);
    const portHex = (parseInt(session.port, 10) || defaultPort(protocol)).toString(16).toUpperCase().padStart(8, '0');
    const lines = [
      '[S:' + safeName(session.name) + ']',
      'S:"Hostname"=' + safe(session.host),
      'D:"[' + protocolName(protocol) + '] Port"=' + portHex,
      'S:"Username"=' + safe(session.user),
      'S:"Protocol Name"=' + protocolName(protocol),
      'S:"Session Name"=' + safeName(session.name),
      'S:"[SSH2] Auth"=' + (session.auth === 'privatekey' ? 'PublicKey' : 'Password'),
      (session.auth === 'privatekey' ? 'S:"[SSH2] Public Key File"=' + safe(session.keyfile) : ''),
      'S:"Password V2"=',
      'D:"Session Password Saved"=00000000',
      'S:"Emulation Name"=Xterm',
      ''
    ];
    return { name: safeName(session.name) + '.ini', content: lines.filter((l) => l !== null && l !== undefined).join('\r\n') };
  }

  function toOpenShell(sessions, vaultPayload) {
    const list = sessions.map((s) => ({
      id: safe(s.id),
      name: safe(s.name), group: safe(s.group), host: safe(s.host),
      port: parseInt(s.port, 10) || defaultPort(normalizeProtocol(s.protocol)), user: safe(s.user),
      protocol: normalizeProtocol(s.protocol),
      auth: s.auth === 'privatekey' ? 'privatekey' : 'password',
      keyfile: safe(s.keyfile)
    }));
    // 带主密码加密的密码保险库 -> 用带标记的对象封装；否则保持纯数组（兼容旧版）
    const content = vaultPayload
      ? JSON.stringify({ format: 'openshell-vault', version: 2, openshellVault: vaultPayload, sessions: list }, null, 2)
      : JSON.stringify(list, null, 2);
    return { name: 'openshell-sessions.json', content };
  }

  return {
    PROTOCOLS, protocolFrom, normalizeProtocol, defaultPort, protocolName,
    guessFormat, parseFile, parseOpenSsh, parseOpenSshVault, parseXshellIni, parseXshellXml, parseSecureCrt,
    toXshell, toSecureCrt, toOpenShell, safeName
  };
});
