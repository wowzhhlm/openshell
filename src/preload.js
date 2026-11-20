const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_CHANNELS = [
  'app:version',
  'app:outputDirs',
  'app:openPath',
  'dialog:selectPrivateKey',
  'dialog:saveFile',
  'dialog:selectImportFiles',
  'dialog:selectImportDir',
  'dialog:selectExportDir',
  'export:writeFiles',
  'cred:save',
  'cred:remove',
  'cred:exportAll',
  'cred:importMany',
  'ssh:connect',
  'telnet:connect',
  'local:spawn',
  'rdp:launch',
  'ftp:connect',
  'ftp:list',
  'ftp:download',
  'ftp:delete',
  'net:deployConfig',
  'topology:open',
  'vault:status',
  'vault:setMaster',
  'vault:verifyMaster',
  'vault:encrypt',
  'vault:decrypt',
  'vault:clearMaster',
  'clipboard:readText',
  'clipboard:writeText',
  'sftp:readdir',
  'sftp:upload',
  'sftp:download',
  'sftp:delete'
];

const SEND_CHANNELS = [
  'ssh:write',
  'ssh:resize',
  'ssh:disconnect',
  'local:write',
  'ftp:close'
];

const ON_CHANNELS = [
  'ssh:data',
  'ssh:close',
  'ssh:error',
  'ssh:status',
  'ssh:progress',
  'ssh:forwardLog',
  'sftp:progress',
  'hostkey:warning'
];

const invoke = (channel, ...args) => {
  if (!INVOKE_CHANNELS.includes(channel)) throw new Error('channel not allowed: ' + channel);
  return ipcRenderer.invoke(channel, ...args);
};
const send = (channel, ...args) => {
  if (!SEND_CHANNELS.includes(channel)) throw new Error('channel not allowed: ' + channel);
  ipcRenderer.send(channel, ...args);
};

contextBridge.exposeInMainWorld('openshell', {
  // 同步通知主进程"当前右键在终端区域"，抑制原生编辑菜单，避免与终端自定义菜单冲突
  setContextGuard: (v) => { try { ipcRenderer.sendSync('ctx:guard', !!v); } catch (_) {} },
  appVersion: () => invoke('app:version'),
  outputDirs: () => invoke('app:outputDirs'),
  openOutputDir: (which) => invoke('app:openPath', which),
  selectPrivateKey: () => invoke('dialog:selectPrivateKey'),
  saveFile: (name) => invoke('dialog:saveFile', name),
  selectImportFiles: () => invoke('dialog:selectImportFiles'),
  selectImportDir: () => invoke('dialog:selectImportDir'),
  selectExportDir: (defaultPath) => invoke('dialog:selectExportDir', defaultPath),
  writeExportFiles: (dir, files) => invoke('export:writeFiles', dir, files),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  readClipboard: () => invoke('clipboard:readText'),
  writeClipboard: (text) => invoke('clipboard:writeText', text),

  saveCredential: (sessionId, password, passphrase) => invoke('cred:save', sessionId, password, passphrase),
  removeCredential: (sessionId) => invoke('cred:remove', sessionId),
  exportAllCredentials: () => invoke('cred:exportAll'),
  importCredentials: (secrets) => invoke('cred:importMany', secrets),

  sshConnect: (tabId, session) => invoke('ssh:connect', tabId, session),
  telnetConnect: (tabId, session) => invoke('telnet:connect', tabId, session),
  localSpawn: (tabId) => invoke('local:spawn', tabId),
  rdpLaunch: (session) => invoke('rdp:launch', session),
  ftpConnect: (tabId, session) => invoke('ftp:connect', tabId, session),
  ftpList: (tabId, dir) => invoke('ftp:list', tabId, dir),
  ftpDownload: (tabId, remotePath, localPath) => invoke('ftp:download', tabId, remotePath, localPath),
  ftpDelete: (tabId, remotePath) => invoke('ftp:delete', tabId, remotePath),
  ftpClose: (tabId) => send('ftp:close', tabId),
  deployConfig: (session, commands) => invoke('net:deployConfig', session, commands),
  openTopology: () => invoke('topology:open'),

  vaultStatus: () => invoke('vault:status'),
  vaultSetMaster: (pw) => invoke('vault:setMaster', pw),
  vaultVerifyMaster: (pw) => invoke('vault:verifyMaster', pw),
  vaultEncrypt: (pw, secrets) => invoke('vault:encrypt', pw, secrets),
  vaultDecrypt: (pw, payload) => invoke('vault:decrypt', pw, payload),
  vaultClearMaster: () => invoke('vault:clearMaster'),

  sshWrite: (tabId, data) => send('ssh:write', tabId, data),
  sshResize: (tabId, cols, rows) => send('ssh:resize', tabId, cols, rows),
  sshDisconnect: (tabId) => send('ssh:disconnect', tabId),
  localWrite: (tabId, data) => send('local:write', tabId, data),

  sftpReaddir: (tabId, dir) => invoke('sftp:readdir', tabId, dir),
  sftpUpload: (tabId, localPath, remotePath) => invoke('sftp:upload', tabId, localPath, remotePath),
  sftpDownload: (tabId, remotePath, localPath) => invoke('sftp:download', tabId, remotePath, localPath),
  sftpDelete: (tabId, remotePath, isDir) => invoke('sftp:delete', tabId, remotePath, isDir),

  on: (channel, handler) => {
    if (!ON_CHANNELS.includes(channel)) throw new Error('channel not allowed: ' + channel);
    const listener = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
