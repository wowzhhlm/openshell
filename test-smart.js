/* test-smart.js — 智能配置引擎纯函数单测（零依赖，可直接在 Node 运行） */
'use strict';
const assert = require('assert');
const S = require('./src/topology/js/smart-config.js');

const passed = [];
function ok(name, fn) {
  fn();
  passed.push(name);
  console.log('PASS: ' + name);
}

/* ---------------- 1. IPv4 工具 ---------------- */
ok('IPv4 合法性与掩码工具', () => {
  assert.strictEqual(S.isValidIpv4('192.168.1.1'), true);
  assert.strictEqual(S.isValidIpv4('01.2.3.4'), false);
  assert.strictEqual(S.isValidIpv4('256.1.1.1'), false);
  assert.strictEqual(S.isValidIpv4('1.2.3'), false);
  assert.strictEqual(S.isValidMask('255.255.255.0'), true);
  assert.strictEqual(S.isValidMask('255.0.255.0'), false);
  assert.strictEqual(S.maskToPrefix('255.255.255.0'), 24);
  assert.strictEqual(S.maskToPrefix('255.255.0.0'), 16);
  assert.strictEqual(S.prefixToMask(24), '255.255.255.0');
  assert.strictEqual(S.prefixToMask(30), '255.255.255.252');
  assert.strictEqual(S.networkOf('192.168.10.55', '255.255.255.0'), '192.168.10.0');
  assert.strictEqual(S.broadcastOf('192.168.10.55', '255.255.255.0'), '192.168.10.255');
  assert.strictEqual(S.sameSubnet('192.168.10.1', '192.168.10.9', '255.255.255.0'), true);
  assert.strictEqual(S.sameSubnet('192.168.10.1', '192.168.11.9', '255.255.255.0'), false);
  assert.strictEqual(S.intToIp(S.ipToInt('10.20.30.40')), '10.20.30.40');
});

/* ---------------- 2. 测试拓扑 ---------------- */
const TOPO = {
  devices: [
    { id: 'r1', name: '路由器-01', type: 'router', vendor: 'huawei',
      ip: '192.168.1.1', mask: '255.255.255.0', gateway: '10.0.0.1' },
    { id: 'sw1', name: '核心交换机', type: 'core_switch', vendor: 'huawei',
      ip: '', mask: '255.255.255.0', switchLayer: 'l3', isCore: true,
      customVlans: [
        { id: '10', name: '办公', ip: '192.168.10.1', mask: '255.255.255.0' },
        { id: '10', name: '办公重复', ip: '192.168.10.2', mask: '255.255.255.0' }
      ] },
    { id: 'sw2', name: '接入交换机', type: 'acc_switch', vendor: 'huawei',
      ip: '192.168.1.1', mask: '255.255.255.0', vlan: '10' },
    { id: 'pc1', name: 'PC-01', type: 'pc', vendor: 'endpoint' }
  ],
  edges: [
    { source: 'r1', target: 'sw1' },
    { source: 'sw1', target: 'sw2' },
    { source: 'sw2', target: 'pc1' }
  ],
  allTopologyVlans: ['10']
};

ok('拓扑规范化与统计', () => {
  const t = S.normalize(TOPO);
  assert.strictEqual(t.devices.length, 4);
  assert.strictEqual(t.edges.length, 3);
  const s = S.summarize(t);
  assert.strictEqual(s.devices, 4);
  assert.strictEqual(s.switches, 2);
  assert.strictEqual(s.routers, 1);
  assert.strictEqual(s.endpoints, 1);
  assert.strictEqual(s.vlans, 1);
  assert.strictEqual(s.withIp, 2);
  assert.strictEqual(S.normalize(null).devices.length, 0);
});

ok('IP 冲突检测：重复地址 / 网关跨网段', () => {
  const issues = S.detectIPConflicts(TOPO);
  assert(issues.some(i => i.code === 'IP_DUPLICATE' && i.device === '接入交换机'), '应检出 sw2 与 r1 的重复 IP');
  assert(issues.some(i => i.code === 'GW_OUT_OF_SUBNET' && i.device === '路由器-01'), '应检出网关跨网段');
});

ok('VLAN 冲突检测：同设备重复 VLAN ID', () => {
  const issues = S.detectVlanConflicts(TOPO);
  assert(issues.some(i => i.code === 'VLAN_DUP_IN_DEVICE' && i.device === '核心交换机'));
  const illegal = S.detectVlanConflicts({ devices: [{ id: 'x', name: 'X', type: 'acc_switch', vlan: '5000' }], edges: [] });
  assert(illegal.some(i => i.code === 'VLAN_RANGE'));
});

ok('配置体检：分级 / 评分 / 结论', () => {
  const r = S.validateConfig(TOPO);
  assert.strictEqual(r.level, 'error');
  assert(r.counts.error >= 2, '至少有 2 个错误');
  assert(r.counts.warn >= 1, '至少有 1 个警告');
  assert(r.score < 100 && r.score >= 0);
  assert(r.issues.some(i => i.code === 'L3_NO_IP' && i.device === '核心交换机'));
  const clean = S.validateConfig({ devices: [], edges: [] });
  assert.strictEqual(clean.level, 'info');
  const text = S.formatReport(r);
  assert(text.includes('OpenShell 智能体检') && text.includes('IP 地址'));
});

ok('自动 IP 规划：不覆盖已有地址 / 分配管理 IP / 生成 VLAN 子网', () => {
  const p = S.planIP(TOPO);
  assert(Array.isArray(p.subnets) && p.subnets.length >= 2);
  assert(p.subnets.some(x => x.vlan === 10 && x.network === '10.10.9.0'), 'VLAN 10 应规划为 10.10.9.0/24');
  assert(p.subnets.some(x => x.vlan === 100), '应生成管理 VLAN 子网');
  const mgmt = p.assignments.filter(a => a.deviceId === 'sw1' && a.field === 'ip');
  assert.strictEqual(mgmt.length, 1, '核心交换机应分配 1 个管理 IP');
  assert(S.isValidIpv4(mgmt[0].value));
  assert(!p.assignments.some(a => a.deviceId === 'r1' && a.field === 'ip'), '已填 IP 的设备不应被覆盖');
  const allAssigned = p.assignments.map(a => a.value);
  assert.strictEqual(new Set(allAssigned).size, allAssigned.length, '规划地址之间不得重复');
});

ok('规划回填补丁 autoApplyPlan', () => {
  const p = S.planIP(TOPO);
  const patches = S.autoApplyPlan(TOPO, p);
  assert(patches.sw1 && S.isValidIpv4(patches.sw1.ip));
  assert.strictEqual(patches.r1, undefined, '无规划项的设备不应产生补丁');
});

/* ---------------- 3. 命令解释 ---------------- */
ok('命令中文解释（华为 / 思科）', () => {
  const hw = S.explainCommands('system-view\nsysname Core-01\nvlan batch 10 20\ninterface Vlanif 10\n ip address 10.10.10.1 255.255.255.0\nsave\n', 'huawei');
  assert(hw.includes('阅读版') && hw.includes('进入系统视图'));
  assert(hw.includes('三层 VLANIF 接口') && hw.includes('把当前配置保存到闪存'));
  const lines = S.explainLines('configure terminal\nhostname SW1\ninterface vlan 10\nip address 1.1.1.1 255.255.255.0\nno shutdown\nwrite memory\n', 'cisco');
  assert(lines.filter(l => l.kind === 'cmd').length >= 6, '思科命令应全部命中规则');
  assert(lines.some(l => l.note && l.note.includes('特权 EXEC') === false && l.note.includes('全局配置模式')));
  const auto = S.explainCommands('undo shutdown\n', 'huawei');
  assert(auto.includes('删除 / 取消'));
});

/* ---------------- 4. 批量脚本拆分与导出 ---------------- */
const GEN_ALL = [
  '! ============================================================',
  '!  批量配置命令 — 生成时间: 2026/11/21',
  '!  设备总数: 2 | 连线总数: 1',
  '! ============================================================',
  '',
  '! ══════════════════════════════════════',
  '!  核心交换机-01',
  '!  类型: 核心交换机 | 厂商: huawei | IP: 10.10.100.10',
  '! ══════════════════════════════════════',
  '',
  'system-view',
  'sysname Core-01',
  'vlan batch 10 20',
  'interface Vlanif 10',
  ' ip address 10.10.10.1 255.255.255.0',
  'quit',
  'save',
  '',
  '! ══════════════════════════════════════',
  '!  接入交换机-01',
  '!  类型: 接入交换机 | 厂商: huawei | IP: 10.10.100.11',
  '! ══════════════════════════════════════',
  '',
  'system-view',
  'vlan 10',
  'interface GigabitEthernet0/0/1',
  ' port link-type access',
  ' port default vlan 10',
  'save',
  '',
  '! ============================================================',
  '!  批量配置命令结束',
  '! ============================================================'
].join('\n');

ok('批量脚本按设备拆分', () => {
  const blocks = S.splitDeviceScripts(GEN_ALL);
  assert.strictEqual(blocks.length, 2, '应拆出 2 台设备');
  assert.strictEqual(blocks[0].name, '核心交换机-01');
  assert.strictEqual(blocks[1].name, '接入交换机-01');
  assert(blocks[0].content.includes('sysname Core-01'));
  assert(blocks[1].content.includes('port default vlan 10'));
  assert(!blocks[0].content.includes('接入交换机-01'), '不同设备的命令不能串块');
  assert.strictEqual(S.splitDeviceScripts('').length, 0);
});

ok('批量导出：每设备 .cfg + 合并配置包', () => {
  const pkg = S.batchExport(GEN_ALL, { score: 87, generatedAt: '2026/11/21 12:00' });
  assert.strictEqual(pkg.count, 2);
  assert.strictEqual(pkg.files.length, 2);
  assert(pkg.files[0].name.startsWith('01_') && pkg.files[0].name.endsWith('.cfg'));
  assert(pkg.files.every(f => f.content.includes('OpenShell 网络版 · 设备配置脚本')));
  assert(pkg.files.every(f => f.content.includes('拓扑体检评分: 87/100')));
  assert(pkg.packageText.includes('批量配置包') && pkg.packageText.includes('设备文件数: 2'));
  assert.strictEqual(pkg.packageName, 'openshell-配置包.txt');
  assert.strictEqual(S.safeFileName('核心/交换:机*01'), '核心_交换_机_01');
});

ok('组合入口 analyzeAll', () => {
  const a = S.analyzeAll(TOPO);
  assert.strictEqual(a.stats.devices, 4);
  assert.strictEqual(a.report.level, 'error');
  assert(a.plan.subnets.length >= 2);
  assert.strictEqual(typeof S.VERSION, 'string');
});

console.log('\n共 ' + passed.length + ' 项通过');
console.log('SMART_ALL_PASS — 智能配置引擎纯函数测试全部通过');
