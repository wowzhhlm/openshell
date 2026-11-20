/* test-import.js — 验证 CSV/TSV 表格导入与 .xts 加密格式提示 */
const assert = require('assert');
const Fmt = require('./src/session-format');

// 1. Xshell 固定列顺序 CSV（无表头）
const csvNoHeader = 'Web服务器,192.168.1.10,SSH,22,root,,\n数据库,10.0.0.5,SSH,2222,admin,,\n';
let r = Fmt.parseFile({ name: 'xshell.csv', text: csvNoHeader });
assert.strictEqual(r.format, 'csv');
assert.strictEqual(r.sessions.length, 2, 'CSV 无表头解析出 2 个会话');
assert.strictEqual(r.sessions[0].host, '192.168.1.10');
assert.strictEqual(r.sessions[0].user, 'root');
assert.strictEqual(r.sessions[0].protocol, 'ssh');
assert.strictEqual(r.sessions[1].port, 2222);
console.log('PASS: Xshell 固定列顺序 CSV（无表头）');

// 2. 中文表头 + 乱序列 + 引号字段
const csvHeader = '会话名称,主机地址,端口,用户名,协议,分组,备注\n'
  + '"核心交换机",10.1.1.1,22,admin,SSH,网络设备,"带 \"引号\" 的备注"\n'
  + '分支路由,10.2.2.2,23,ops,Telnet,网络设备,\n';
r = Fmt.parseFile({ name: 'list.csv', text: csvHeader });
assert.strictEqual(r.sessions.length, 2, '中文表头 CSV 解析出 2 个会话');
assert.strictEqual(r.sessions[0].host, '10.1.1.1');
assert.strictEqual(r.sessions[0].group, '网络设备');
assert.strictEqual(r.sessions[1].protocol, 'telnet');
assert.strictEqual(r.sessions[1].port, 23);
console.log('PASS: 中文表头/乱序列/引号字段 CSV');

// 3. TSV（制表符分隔）
const tsv = 'Name\tHost\tProtocol\tPort\tUser\tPassword\tDescription\n'
  + 'A\t172.16.0.1\tSSH\t22\troot\tpwd123\t备注A\n';
r = Fmt.parseFile({ name: 'sessions.tsv', text: tsv });
assert.strictEqual(r.format, 'tsv');
assert.strictEqual(r.sessions.length, 1);
assert.strictEqual(r.sessions[0].host, '172.16.0.1');
assert(r.warning && r.warning.includes('明文密码'), 'TSV 明文密码应给出安全提示');
console.log('PASS: TSV 解析 + 明文密码安全提示');

// 4. UTF-8 BOM
r = Fmt.parseFile({ name: 'bom.csv', text: '\uFEFFName,Host,Port,User\nX,8.8.8.8,22,root\n' });
assert.strictEqual(r.sessions.length, 1, 'BOM 不影响解析');
console.log('PASS: UTF-8 BOM 处理');

// 5. .xts 专有加密格式 → 明确警告而非假装解析
r = Fmt.parseFile({ name: 'session.xts', text: '\x00\x01BINARYENCRYPTED' });
assert.strictEqual(r.format, 'xts');
assert.strictEqual(r.sessions.length, 0);
assert(r.warning && r.warning.includes('加密归档'), 'xts 应返回加密格式说明');
assert(r.warning && r.warning.includes('CSV'), 'xts 提示应给出 CSV 替代方案');
console.log('PASS: .xts 加密格式明确提示 + 替代方案');

// 6. 分号分隔 + 分组目录名
r = Fmt.parseFile({ name: 'a.csv', text: 'Name;Host;Port;User\nS1;192.168.5.5;22;admin\n', group: '分支' });
assert.strictEqual(r.sessions.length, 1);
assert.strictEqual(r.sessions[0].group, '分支');
console.log('PASS: 分号分隔 + 分组');

// 7. 回归：原有格式不受影响
assert.strictEqual(Fmt.guessFormat('[Connection]\nHost=1.2.3.4\n', 'x.xsh'), 'xshell-ini');
assert.strictEqual(Fmt.guessFormat('S:"Hostname"=1.2.3.4', 'x.ini'), 'securecrt');
assert.strictEqual(Fmt.guessFormat('[{"host":"1.2.3.4"}]', 'x.json'), 'openshell');
console.log('PASS: 原有格式识别回归');

console.log('IMPORT_ALL_PASS');
