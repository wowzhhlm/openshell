/* ============================================================
   smart-config.js — OpenShell 网络版 · 自研智能配置引擎
   ------------------------------------------------------------
   · 纯函数、零外部依赖：可在浏览器 <script> 直接引用，也可在 Node 中 require 单测
   · 不复制第三方引擎的实现，仅通过 analyzeTopology() / CmdTpl 的公开输出协作
   · 能力：拓扑规范化 / IPv4 工具 / 自动 IP 规划 / IP+VLAN 冲突检测 /
           配置体检与评分 / 规划回填补丁 / 命令中文解释 / 批量脚本拆分与导出
   ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SmartConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ==========================================================
     1. IPv4 工具
     ========================================================== */
  function isValidIpv4(s) {
    if (typeof s !== 'string') return false;
    var p = s.trim().split('.');
    if (p.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(p[i])) return false;
      var n = Number(p[i]);
      if (n < 0 || n > 255) return false;
      if (p[i].length > 1 && p[i].charAt(0) === '0') return false;
    }
    return true;
  }

  function ipToInt(ip) {
    var p = String(ip).trim().split('.');
    return ((Number(p[0]) << 24) | (Number(p[1]) << 16) | (Number(p[2]) << 8) | Number(p[3])) >>> 0;
  }

  function intToIp(n) {
    n = n >>> 0;
    return [ (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255 ].join('.');
  }

  function isValidMask(mask) {
    if (!isValidIpv4(mask)) return false;
    var n = ipToInt(mask), seenZero = false, bits = 0;
    for (var i = 31; i >= 0; i--) {
      var b = (n >>> i) & 1;
      if (b) { if (seenZero) return false; bits++; }
      else seenZero = true;
    }
    return bits >= 1 && bits <= 32;
  }

  function maskToPrefix(mask) {
    if (!isValidMask(mask)) return 24;
    var n = ipToInt(mask), c = 0;
    while (n & 0x80000000) { c++; n = (n << 1) >>> 0; }
    return c;
  }

  function prefixToMask(p) {
    p = Math.max(0, Math.min(32, Number(p) || 0));
    return intToIp(p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0);
  }

  function networkOf(ip, mask) {
    if (!isValidIpv4(ip) || !isValidMask(mask)) return '';
    return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
  }

  function broadcastOf(ip, mask) {
    if (!isValidIpv4(ip) || !isValidMask(mask)) return '';
    return intToIp(((ipToInt(ip) & ipToInt(mask)) | ((~ipToInt(mask)) >>> 0)) >>> 0);
  }

  function sameSubnet(a, b, mask) {
    if (!isValidIpv4(a) || !isValidIpv4(b) || !isValidMask(mask)) return false;
    return ((ipToInt(a) & ipToInt(mask)) >>> 0) === ((ipToInt(b) & ipToInt(mask)) >>> 0);
  }

  /* ==========================================================
     2. 拓扑采集与规范化
     ========================================================== */
  function isEndpoint(type) {
    return ['pc', 'server', 'camera', 'nvr', 'endpoint'].indexOf(String(type)) >= 0;
  }
  function isSwitch(type) {
    return ['core_switch', 'agg_switch', 'acc_switch', 'switch'].indexOf(String(type)) >= 0;
  }
  function needManagementIp(d) {
    return d.type === 'router' || d.type === 'core_switch' || d.switchLayer === 'l3' || d.isCore || d.isRoot;
  }

  function normalize(topology) {
    var t = topology || {};
    var devices = (t.devices || []).map(function (d, i) {
      var dv = d || {};
      return {
        id:           String(dv.id || ('dev-' + (i + 1))),
        name:         String(dv.name || dv.label || dv.id || ('设备' + (i + 1))),
        type:         String(dv.type || 'acc_switch'),
        vendor:       String(dv.vendor || ''),
        ip:           String(dv.ip || '').trim(),
        gateway:      String(dv.gateway || '').trim(),
        mask:         String(dv.mask || '255.255.255.0').trim(),
        vlan:         String(dv.vlan || '').trim(),
        switchLayer:  String(dv.switchLayer || 'l2'),
        ports:        Number(dv.ports || 0),
        customVlans:  (dv.customVlans || []).map(function (v) {
          var vv = v || {};
          return {
            id: String(vv.id || '').trim(), name: String(vv.name || ''),
            desc: String(vv.desc || ''), ip: String(vv.ip || '').trim(),
            mask: String(vv.mask || '').trim()
          };
        }),
        vlansOnDevice: (dv.vlansOnDevice || []).map(String),
        features:      dv.features || {},
        uplinks:       dv.uplinks || [],
        downlinks:     dv.downlinks || [],
        endpoints:     dv.endpoints || [],
        peerDevices:   dv.peerDevices || [],
        isCore:        !!dv.isCore,
        isRoot:        !!dv.isRoot
      };
    });
    var edges = (t.edges || []).map(function (e) {
      var ee = e || {}, data = ee.data || {};
      return {
        source: String(ee.source || ''), target: String(ee.target || ''),
        fromPort: data.fromPort, toPort: data.toPort,
        linkType: String(data.linkType || ee.linkType || 'copper')
      };
    });
    return {
      devices: devices, edges: edges,
      allTopologyVlans: (t.allTopologyVlans || []).map(String)
    };
  }

  /** 浏览器内从 G6 graph 采集；优先复用引擎的 analyzeTopology()，失败则直接读 model */
  function fromGraph(g) {
    if (!g) return normalize(null);
    var base = null;
    try {
      if (typeof root.analyzeTopology === 'function') base = root.analyzeTopology(g);
    } catch (e) { base = null; }
    if (base && base.devices) {
      if (!base.edges && g.getEdges) {
        base.edges = g.getEdges().map(function (e) { return e.getModel(); });
      }
      return normalize(base);
    }
    // 兜底：直接读 G6 model.data
    var devices = [], edges = [];
    if (g.getNodes) g.getNodes().forEach(function (n) {
      var m = n.getModel(), d = m.data || {};
      devices.push({
        id: m.id, name: m.label || d.name || m.id, type: m.type || d.type,
        vendor: d.vendor, ip: d.ip, gateway: d.gateway, mask: d.mask,
        vlan: d.vlan, switchLayer: d.switchLayer, ports: d.ports,
        customVlans: d.customVlans || [], features: d.features || {}
      });
    });
    if (g.getEdges) g.getEdges().forEach(function (e) { edges.push(e.getModel()); });
    return normalize({ devices: devices, edges: edges });
  }

  function summarize(topology) {
    var t = normalize(topology);
    var s = { devices: t.devices.length, switches: 0, routers: 0, endpoints: 0,
              edges: t.edges.length, vlans: 0, withIp: 0, withoutVendor: 0 };
    var vlans = {};
    t.devices.forEach(function (d) {
      if (isSwitch(d.type)) s.switches++;
      else if (d.type === 'router') s.routers++;
      if (isEndpoint(d.type)) s.endpoints++;
      if (d.ip) s.withIp++;
      if (!isEndpoint(d.type) && !d.vendor) s.withoutVendor++;
      if (d.vlan) vlans[d.vlan] = 1;
      d.customVlans.forEach(function (v) { if (v.id) vlans[v.id] = 1; });
      d.vlansOnDevice.forEach(function (v) { vlans[v] = 1; });
    });
    (t.allTopologyVlans || []).forEach(function (v) { vlans[v] = 1; });
    s.vlans = Object.keys(vlans).length;
    return s;
  }

  /** VLAN 汇总：{ id: { names, ips, devices, subnetKeys } } */
  function collectVlanMap(t) {
    var map = {};
    function touch(id) {
      var key = String(id);
      if (!map[key]) map[key] = { id: key, names: [], ips: [], devices: [], subnetKeys: [] };
      return map[key];
    }
    (t.allTopologyVlans || []).forEach(function (v) { if (v) touch(v); });
    t.devices.forEach(function (d) {
      if (d.vlan) { touch(d.vlan).devices.push(d.name); }
      d.customVlans.forEach(function (v) {
        if (!v.id) return;
        var e = touch(v.id);
        if (v.name) e.names.push(v.name);
        if (v.ip) {
          e.ips.push(v.ip);
          var net = networkOf(v.ip, v.mask || '255.255.255.0');
          if (net) e.subnetKeys.push(net);
        }
        e.devices.push(d.name);
      });
      d.vlansOnDevice.forEach(function (v) { if (v) touch(v); });
    });
    return map;
  }

  /* ==========================================================
     3. 自动 IP 规划
     ========================================================== */
  function planIP(topology, options) {
    var t = normalize(topology);
    var opt = Object.assign({ site: 10, mgmtVlan: 100, gatewayHost: 1, hostStart: 10 }, options || {});
    var site = Math.max(0, Math.min(200, Number(opt.site) || 10));
    var used = {};
    function reserve(ip) { if (isValidIpv4(ip)) used[ip] = true; }

    t.devices.forEach(function (d) {
      reserve(d.ip); reserve(d.gateway);
      d.customVlans.forEach(function (v) { reserve(v.ip); });
    });

    function subnetFor(vid) {
      var v = Math.max(1, Number(vid) || 1);
      var second = site + Math.floor((v - 1) / 256);
      var third = (v - 1) % 256;
      var prefix = '10.' + second + '.' + third + '.';
      return { network: prefix + '0', mask: '255.255.255.0', prefix: 24, gateway: prefix + (Number(opt.gatewayHost) || 1), head: prefix };
    }
    function nextFree(sub, start) {
      for (var h = Math.max(2, Number(start) || 10); h <= 254; h++) {
        var ip = sub.head + h;
        if (!used[ip] && ip !== sub.gateway) return ip;
      }
      return '';
    }

    var vlanMap = collectVlanMap(t);
    var ids = Object.keys(vlanMap)
      .filter(function (k) { return /^\d+$/.test(k) && Number(k) >= 1 && Number(k) <= 4094; })
      .sort(function (a, b) { return Number(a) - Number(b); });
    if (ids.indexOf(String(opt.mgmtVlan)) < 0) ids.push(String(opt.mgmtVlan));

    var subnets = [], assignments = [];
    ids.forEach(function (vid) {
      var sub = subnetFor(vid);
      reserve(sub.gateway);
      subnets.push({
        vlan: Number(vid), network: sub.network, mask: sub.mask, prefix: 24,
        gateway: sub.gateway, suggestedRange: sub.head + '10 ~ ' + sub.head + '254'
      });
      t.devices.forEach(function (d) {
        d.customVlans.forEach(function (v) {
          if (String(v.id) !== vid || v.ip) return;
          var ip = nextFree(sub, opt.hostStart);
          if (!ip) return;
          reserve(ip);
          assignments.push({
            device: d.name, deviceId: d.id, field: 'customVlan:' + vid + ':ip',
            value: ip, reason: 'VLAN ' + vid + ' 的 VLANIF 地址，按 ' + sub.network + '/24 自动分配'
          });
        });
      });
    });

    // 三层设备管理 IP
    var mgmt = subnetFor(opt.mgmtVlan);
    var cursor = opt.hostStart;
    t.devices.forEach(function (d) {
      if (!needManagementIp(d) || d.ip || isEndpoint(d.type)) return;
      var ip = nextFree(mgmt, cursor);
      if (!ip) return;
      reserve(ip);
      cursor = Number(ip.split('.').pop()) + 1;
      assignments.push({
        device: d.name, deviceId: d.id, field: 'ip', value: ip,
        reason: '三层设备管理地址，自动分配自 ' + mgmt.network + '/24'
      });
      if (!d.gateway) assignments.push({
        device: d.name, deviceId: d.id, field: 'gateway', value: mgmt.gateway,
        reason: '与管理 IP 同网段的默认网关'
      });
    });

    // 已有 IP 但缺网关的设备：按自身网段推导
    t.devices.forEach(function (d) {
      if (d.gateway || !isValidIpv4(d.ip) || !isValidMask(d.mask)) return;
      var gw = intToIp(((ipToInt(networkOf(d.ip, d.mask)) >>> 0) + 1) >>> 0);
      if (gw === d.ip) return;
      if (d.ip === gw) return;
      if (used[gw] && used[gw] !== d.name) return;
      reserve(gw);
      assignments.push({
        device: d.name, deviceId: d.id, field: 'gateway', value: gw,
        reason: '按设备 IP 所在网段 ' + networkOf(d.ip, d.mask) + ' 推导的默认网关'
      });
    });

    return {
      site: site, mgmtVlan: Number(opt.mgmtVlan), subnets: subnets,
      assignments: assignments, usedIps: Object.keys(used).sort()
    };
  }

  /** 把规划结果转成 { deviceId: { field: value } } 补丁，供 UI 写回 graph.updateItem */
  function autoApplyPlan(topology, plan) {
    var t = normalize(topology), byId = {}, patches = {};
    t.devices.forEach(function (d) { byId[d.id] = d; });
    ((plan && plan.assignments) || []).forEach(function (a) {
      if (!a || !a.deviceId || !a.value) return;
      var p = patches[a.deviceId] || (patches[a.deviceId] = {});
      if (String(a.field).indexOf('customVlan:') === 0) {
        var vid = String(a.field).split(':')[1];
        if (!p.customVlans) {
          p.customVlans = ((byId[a.deviceId] && byId[a.deviceId].customVlans) || [])
            .map(function (v) { return Object.assign({}, v); });
        }
        var found = null;
        p.customVlans.forEach(function (v) { if (String(v.id) === vid) found = v; });
        if (found) found.ip = a.value;
        else p.customVlans.push({ id: vid, name: '', desc: '', ip: a.value, mask: '255.255.255.0' });
        if (!p.mask) p.mask = '255.255.255.0';
      } else {
        p[a.field] = a.value;
      }
    });
    return patches;
  }

  /* ==========================================================
     4. 冲突检测
     ========================================================== */
  function detectIPConflicts(topology) {
    var t = normalize(topology), issues = [], seen = {};
    function addIp(ip, owner) {
      if (!ip) return;
      if (!isValidIpv4(ip)) {
        issues.push({ severity: 'error', code: 'IP_INVALID', device: owner,
          message: 'IP 地址格式非法：' + ip, suggestion: '填写合法 IPv4，例如 192.168.10.1' });
        return;
      }
      if (seen[ip]) issues.push({ severity: 'error', code: 'IP_DUPLICATE', device: owner,
        message: 'IP 地址 ' + ip + ' 与「' + seen[ip] + '」重复', suggestion: '为其中一台设备更换地址' });
      else seen[ip] = owner;
    }
    t.devices.forEach(function (d) {
      addIp(d.ip, d.name);
      addIp(d.gateway, d.name + '（网关）');
      if (d.mask && !isValidMask(d.mask)) issues.push({ severity: 'warn', code: 'MASK_INVALID', device: d.name,
        message: '子网掩码非法：' + d.mask, suggestion: '使用连续 1 的掩码，如 255.255.255.0' });
      d.customVlans.forEach(function (v) { addIp(v.ip, d.name + ' / VLAN ' + v.id); });
      if (d.ip && isValidIpv4(d.ip) && isValidMask(d.mask)) {
        if (d.ip === networkOf(d.ip, d.mask)) issues.push({ severity: 'error', code: 'IP_IS_NETWORK', device: d.name,
          message: d.ip + ' 是网段的网络号，不能分配给设备', suggestion: '改用同一网段内的主机地址' });
        if (d.ip === broadcastOf(d.ip, d.mask)) issues.push({ severity: 'error', code: 'IP_IS_BROADCAST', device: d.name,
          message: d.ip + ' 是网段的广播地址，不能分配给设备', suggestion: '改用同一网段内的主机地址' });
      }
      if (d.gateway && isValidIpv4(d.gateway) && d.ip && isValidIpv4(d.ip) && isValidMask(d.mask)
          && !sameSubnet(d.ip, d.gateway, d.mask)) {
        issues.push({ severity: 'warn', code: 'GW_OUT_OF_SUBNET', device: d.name,
          message: '网关 ' + d.gateway + ' 与设备 IP ' + d.ip + ' 不在同一网段',
          suggestion: '把网关改为 ' + networkOf(d.ip, d.mask) + ' 网段内的地址' });
      }
    });
    return issues;
  }

  function detectVlanConflicts(topology) {
    var t = normalize(topology), issues = [], vlanMap = collectVlanMap(t);
    Object.keys(vlanMap).forEach(function (vid) {
      var e = vlanMap[vid];
      if (!/^\d+$/.test(vid) || Number(vid) < 1 || Number(vid) > 4094) {
        issues.push({ severity: 'error', code: 'VLAN_RANGE', device: e.devices[0] || '—',
          message: 'VLAN ID「' + vid + '」非法', suggestion: '有效范围 1–4094；VLAN 1 为默认 VLAN，建议业务从 10 起编号' });
        return;
      }
      var nets = [];
      e.subnetKeys.forEach(function (n) { if (nets.indexOf(n) < 0) nets.push(n); });
      if (nets.length > 1) issues.push({ severity: 'warn', code: 'VLAN_MULTI_SUBNET', device: 'VLAN ' + vid,
        message: '同一 VLAN ' + vid + ' 在不同设备上使用了 ' + nets.length + ' 个不同网段（' + nets.join(', ') + '）',
        suggestion: '统一该 VLAN 的三层网段，或改用不同的 VLAN ID' });
      if (Number(vid) === 1) issues.push({ severity: 'info', code: 'VLAN_DEFAULT', device: 'VLAN 1',
        message: '使用了默认 VLAN 1', suggestion: '生产网络建议把业务流量迁出 VLAN 1' });
    });

    t.devices.forEach(function (d) {
      var local = {};
      d.customVlans.forEach(function (v) {
        if (!v.id) return;
        if (local[v.id]) issues.push({ severity: 'error', code: 'VLAN_DUP_IN_DEVICE', device: d.name,
          message: 'VLAN ' + v.id + ' 在该设备上重复定义', suggestion: '删除重复的 VLAN 行' });
        local[v.id] = true;
        if (v.ip && !isValidIpv4(v.ip)) issues.push({ severity: 'error', code: 'VLANIF_INVALID', device: d.name,
          message: 'VLAN ' + v.id + ' 的 VLANIF 地址非法：' + v.ip, suggestion: '填写合法 IPv4' });
        if (v.mask && !isValidMask(v.mask)) issues.push({ severity: 'warn', code: 'VLANIF_MASK', device: d.name,
          message: 'VLAN ' + v.id + ' 的掩码非法：' + v.mask, suggestion: '例如 255.255.255.0' });
      });
    });

    var byId = {}; t.devices.forEach(function (d) { byId[d.id] = d; });
    function vlanSet(d) {
      var s = {};
      if (d.vlan) s[d.vlan] = 1;
      d.customVlans.forEach(function (v) { if (v.id) s[v.id] = 1; });
      d.vlansOnDevice.forEach(function (v) { if (v) s[v] = 1; });
      return Object.keys(s).sort(function (a, b) { return Number(a) - Number(b); });
    }
    t.edges.forEach(function (ed) {
      var a = byId[ed.source], b = byId[ed.target];
      if (!a || !b) return;
      var sa = vlanSet(a), sb = vlanSet(b);
      if (sa.length && sb.length && sa.join(',') !== sb.join(',')) {
        issues.push({ severity: 'info', code: 'TRUNK_VLAN_DIFF', device: a.name + ' ↔ ' + b.name,
          message: '链路两端 VLAN 集合不同（' + sa.join('/') + ' vs ' + sb.join('/') + '）',
          suggestion: '确认 trunk 已放行两端全部业务 VLAN，否则跨设备同 VLAN 无法互通' });
      }
    });
    return issues;
  }

  function validateConfig(topology) {
    var t = normalize(topology);
    var issues = detectIPConflicts(t).concat(detectVlanConflicts(t));
    if (!t.devices.length) issues.push({ severity: 'info', code: 'EMPTY', device: '—',
      message: '画布中没有设备', suggestion: '从左侧拖入设备后再次体检' });
    if (t.devices.length > 1 && !t.edges.length) issues.push({ severity: 'warn', code: 'NO_LINKS', device: '—',
      message: '设备之间没有任何连线', suggestion: '用连线模式把交换机 / 路由器 / 终端连起来，模板才能推导 uplink' });
    var connected = {};
    t.edges.forEach(function (e) { connected[e.source] = 1; connected[e.target] = 1; });
    t.devices.forEach(function (d) {
      if (t.edges.length && !connected[d.id]) issues.push({ severity: 'info', code: 'ISOLATED', device: d.name,
        message: '该设备未连接任何其他设备', suggestion: '连线后生成的 trunk / access 配置才完整' });
      if (needManagementIp(d) && !d.ip && !isEndpoint(d.type)) issues.push({ severity: 'warn', code: 'L3_NO_IP', device: d.name,
        message: '三层设备未配置管理 IP', suggestion: '点击「自动规划 IP」一键回填，或手动填写' });
      if (!isEndpoint(d.type) && !d.vendor) issues.push({ severity: 'warn', code: 'NO_VENDOR', device: d.name,
        message: '未选择厂商，生成命令时会被跳过', suggestion: '在右侧面板为该设备选择厂商' });
      if (isSwitch(d.type) && !d.vlan && !d.customVlans.length) issues.push({ severity: 'info', code: 'NO_VLAN', device: d.name,
        message: '该交换机未定义业务 VLAN', suggestion: '用「批量编辑 VLAN」定义 VLAN 与 VLANIF 地址' });
    });
    var counts = { error: 0, warn: 0, info: 0 };
    issues.forEach(function (i) { if (counts[i.severity] != null) counts[i.severity]++; });
    var score = Math.max(0, 100 - counts.error * 15 - counts.warn * 5 - counts.info * 1);
    var level = counts.error > 0 ? 'error' : (counts.warn > 0 ? 'warn' : (counts.info > 0 ? 'info' : 'ok'));
    return { level: level, counts: counts, score: score, issues: issues, generatedAt: new Date().toISOString() };
  }

  function formatReport(report) {
    var r = report || {}, c = r.counts || { error: 0, warn: 0, info: 0 }, lines = [];
    var label = { error: '错误', warn: '警告', info: '提示' };
    lines.push('! ══════════════ OpenShell 智能体检 ══════════════');
    lines.push('! 评分: ' + (r.score == null ? '—' : r.score) + '/100  |  错误 ' + c.error + ' / 警告 ' + c.warn + ' / 提示 ' + c.info);
    lines.push('! 结论: ' + ({ error: '存在必须修复的错误，请勿直接下发', warn: '存在风险项，建议修复后下发', info: '配置基本可用，以下是优化建议', ok: '未发现问题' }[r.level] || '—'));
    lines.push('! ──────────────────────────────────────────────');
    (r.issues || []).forEach(function (it) {
      lines.push('! [' + (label[it.severity] || it.severity) + '] ' + (it.device || '—') + ' — ' + it.message);
      if (it.suggestion) lines.push('!        → ' + it.suggestion);
    });
    if (!(r.issues || []).length) lines.push('! 无问题项。');
    lines.push('! ══════════════════════════════════════════════');
    return lines.join('\n');
  }

  /* ==========================================================
     5. 命令中文解释
     ========================================================== */
  var EXPLAIN_RULES = {
    huawei: [
      { re: /^(system-view|sys)\s*$/i, note: '进入系统视图，之后的全局配置命令都在此视图下生效' },
      { re: /^sysname\s+\S+/i, note: '设置设备主机名' },
      { re: /^vlan\s+batch\s+/i, note: '批量创建多个 VLAN' },
      { re: /^vlan\s+\d+/i, note: '创建单个 VLAN 并进入 VLAN 视图' },
      { re: /^interface\s+Vlanif\s*\d+/i, note: '创建三层 VLANIF 接口，作为该 VLAN 的网关' },
      { re: /^interface\s+(GigabitEthernet|Eth-Trunk|XGigabitEthernet|LoopBack)/i, note: '进入物理/聚合/环回接口视图' },
      { re: /^ip\s+address\s+/i, note: '为当前接口配置 IPv4 地址与掩码' },
      { re: /^port\s+link-type\s+/i, note: '设置端口链路类型：access 接终端、trunk 接交换机、hybrid 混合' },
      { re: /^port\s+trunk\s+allow-pass\s+vlan\s+/i, note: '指定 trunk 允许通过的 VLAN 列表' },
      { re: /^port\s+(default|access)\s+vlan\s+/i, note: '把 access 端口划入指定 VLAN' },
      { re: /^port\s+trunk\s+pvid\s+vlan\s+/i, note: '设置 trunk 端口的缺省 VLAN（PVID）' },
      { re: /^ip\s+route-static\s+/i, note: '配置静态路由：目的网段 + 掩码 + 下一跳/出接口' },
      { re: /^undo\s+/i, note: '删除 / 取消某项配置（华为用 undo 而非 no）' },
      { re: /^save(\s|$)/i, note: '把当前配置保存到闪存，重启后不丢失' },
      { re: /^(quit|return)\s*$/i, note: '退出当前视图（return 可直接回到用户视图）' },
      { re: /^display\s+/i, note: '查看运行状态/配置，不修改设备' },
      { re: /^(stp|dhcp|ospf|lldp|ntp|snmp-agent)\s+(enable|disable)?/i, note: '启用/关闭对应协议或服务' },
      { re: /^#/, note: '' }
    ],
    cisco: [
      { re: /^enable\s*$/i, note: '进入特权 EXEC 模式' },
      { re: /^(configure\s+terminal|conf\s+t)\s*$/i, note: '进入全局配置模式' },
      { re: /^hostname\s+\S+/i, note: '设置设备主机名' },
      { re: /^vlan\s+\d+/i, note: '创建 VLAN 并进入 VLAN 配置模式' },
      { re: /^name\s+\S+/i, note: '为当前 VLAN 命名' },
      { re: /^interface\s+(vlan|Vlan)\s*\d+/i, note: '创建三层 SVI 接口，作为该 VLAN 的网关' },
      { re: /^interface\s+(GigabitEthernet|FastEthernet|TenGigabitEthernet|Port-channel|Loopback)/i, note: '进入物理/聚合/环回接口配置模式' },
      { re: /^ip\s+address\s+/i, note: '为当前接口配置 IPv4 地址与掩码' },
      { re: /^switchport\s+mode\s+/i, note: '设置端口为 access / trunk 模式' },
      { re: /^switchport\s+trunk\s+allowed\s+vlan\s+/i, note: '指定 trunk 允许通过的 VLAN 列表' },
      { re: /^switchport\s+access\s+vlan\s+/i, note: '把 access 端口划入指定 VLAN' },
      { re: /^ip\s+route\s+/i, note: '配置静态路由' },
      { re: /^ip\s+routing\s*$/i, note: '启用三层路由转发' },
      { re: /^no\s+shutdown\s*$/i, note: '启用（打开）当前接口' },
      { re: /^no\s+/i, note: '删除 / 取消某项配置' },
      { re: /^(write\s+memory|copy\s+running-config\s+startup-config)/i, note: '保存当前配置到 NVRAM' },
      { re: /^exit\s*$/i, note: '退出当前配置模式' },
      { re: /^show\s+/i, note: '查看运行状态/配置，不修改设备' },
      { re: /^spanning-tree\s+/i, note: '配置生成树协议' }
    ],
    h3c: [
      { re: /^(system-view|sys)\s*$/i, note: '进入系统视图' },
      { re: /^sysname\s+\S+/i, note: '设置设备主机名' },
      { re: /^vlan\s+\d+/i, note: '创建 VLAN 并进入 VLAN 视图' },
      { re: /^interface\s+Vlan-interface\s*\d+/i, note: '创建三层 VLAN 接口（H3C 网关接口）' },
      { re: /^interface\s+(GigabitEthernet|Bridge-Aggregation)/i, note: '进入物理/聚合接口视图' },
      { re: /^ip\s+address\s+/i, note: '为当前接口配置 IPv4 地址' },
      { re: /^port\s+link-type\s+/i, note: '设置端口链路类型' },
      { re: /^port\s+trunk\s+permit\s+vlan\s+/i, note: '指定 trunk 允许通过的 VLAN 列表' },
      { re: /^port\s+access\s+vlan\s+/i, note: '把 access 端口划入指定 VLAN' },
      { re: /^ip\s+route-static\s+/i, note: '配置静态路由' },
      { re: /^undo\s+/i, note: '删除 / 取消某项配置' },
      { re: /^save\s+force/i, note: '强制保存当前配置' },
      { re: /^(quit|return)\s*$/i, note: '退出当前视图' },
      { re: /^display\s+/i, note: '查看运行状态/配置' }
    ],
    common: [
      { re: /^interface\s+\S+/i, note: '进入接口视图，后续命令作用于该接口' },
      { re: /^ip\s+address\s+/i, note: '配置接口 IPv4 地址与掩码' },
      { re: /^vlan\s+/i, note: '创建 / 进入 VLAN' },
      { re: /^ip\s+route(-static)?\s+/i, note: '配置静态路由' },
      { re: /^(quit|exit|return)\s*$/i, note: '退出当前视图' },
      { re: /^save|write\s+memory|copy\s+running-config/i, note: '保存配置，重启后不丢失' },
      { re: /^(no|undo)\s+/i, note: '删除 / 取消某项配置' },
      { re: /^(display|show)\s+/i, note: '查看类命令，不修改配置' },
      { re: /^#/, note: '' }
    ]
  };

  function explainLines(text, vendor) {
    var v = String(vendor || '').toLowerCase();
    var rules = (EXPLAIN_RULES[v] || []).concat(EXPLAIN_RULES.common);
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) { out.push({ cmd: '', note: '', kind: 'blank' }); return; }
      if (/^[!#]/.test(trimmed) || /^[═=]{5,}/.test(trimmed)) {
        out.push({ cmd: line, note: '', kind: 'comment' }); return;
      }
      var note = '';
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].re.test(trimmed)) { note = rules[i].note; break; }
      }
      out.push({ cmd: line, note: note, kind: note ? 'cmd' : 'plain' });
    });
    return out;
  }

  function explainCommands(text, vendor) {
    var lines = explainLines(text, vendor), out = [];
    out.push('! ══════════ OpenShell 命令解释（阅读版，请勿直接下发）══════════');
    out.push('! 说明: 每个命令行下方以「!   →」给出中文解释；下发前请删除所有 ! 开头的注释行。');
    out.push('! 厂商: ' + (vendor || '自动') + '  |  生成时间: ' + new Date().toLocaleString('zh-CN'));
    out.push('! ══════════════════════════════════════════════════════════');
    lines.forEach(function (l) {
      if (l.kind === 'blank') { out.push(''); return; }
      if (l.kind === 'comment') { out.push(l.cmd); return; }
      out.push(l.cmd);
      if (l.note) out.push('!   → ' + l.note);
    });
    return out.join('\n');
  }

  /* ==========================================================
     6. 批量脚本拆分与导出
     ========================================================== */
  function safeFileName(name) {
    var s = String(name || 'device').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
    s = s.replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
    return (s || 'device').slice(0, 60);
  }

  /** 把 CmdTpl.generateAll() 的合并文本拆成每台设备一段 */
  function splitDeviceScripts(text) {
    var lines = String(text || '').split(/\r?\n/);
    var blocks = [], cur = null;
    var SEP = /^!\s*═{10,}/;                 // 设备块分隔（全角 ═）
    var ENDTEXT = /^!\s*批量配置命令结束/;
    var HEADER = /批量配置命令|设备总数|连线总数|分析引擎/;
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (SEP.test(trimmed)) {
        if (cur && cur.sepSeen) { blocks.push(cur); cur = null; }
        else if (cur) { cur.sepSeen = true; }
        continue;
      }
      if (ENDTEXT.test(trimmed)) { if (cur) { blocks.push(cur); cur = null; } continue; }
      if (!cur) {
        if (/^!\s{2}\S/.test(lines[i]) && !HEADER.test(trimmed)) {
          cur = { name: trimmed.replace(/^!\s+/, ''), lines: [], sepSeen: false };
        }
        continue;
      }
      cur.lines.push(lines[i]);
    }
    if (cur) blocks.push(cur);

    return blocks.map(function (b, idx) {
      var arr = b.lines.slice();
      while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
      // 去掉尾部残留的半角总横幅
      while (arr.length && /^!\s*=+\s*$/.test(arr[arr.length - 1].trim())) arr.pop();
      while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
      return { index: idx + 1, name: b.name, content: arr.join('\n').trim() + '\n' };
    }).filter(function (b) {
      return b.content.replace(/[!\s═=]/g, '').length > 0;
    });
  }

  function deviceFileHeader(b, opt) {
    var lines = [];
    lines.push('! ══════════════════════════════════════════');
    lines.push('! OpenShell 网络版 · 设备配置脚本');
    lines.push('! 设备: ' + b.name);
    lines.push('! 序号: ' + b.index + '  |  生成时间: ' + (opt && opt.generatedAt || new Date().toLocaleString('zh-CN')));
    if (opt && opt.score != null) lines.push('! 拓扑体检评分: ' + opt.score + '/100');
    lines.push('! ⚠ 请人工复核后再下发；「!」开头为阅读注释，部分设备不接受注释行，可整行删除。');
    lines.push('! ══════════════════════════════════════════');
    lines.push('');
    return lines.join('\n');
  }

  function buildPackage(files, meta) {
    var m = meta || {}, out = [];
    out.push('! ============================================================');
    out.push('!  OpenShell 网络版 · 批量配置包');
    out.push('!  生成时间: ' + (m.generatedAt || new Date().toLocaleString('zh-CN')));
    out.push('!  设备文件数: ' + ((files || []).length));
    if (m.score != null) out.push('!  拓扑体检评分: ' + m.score + '/100');
    out.push('! ============================================================');
    out.push('');
    (files || []).forEach(function (f) {
      out.push('! ── ' + f.name + ' ──');
      out.push(f.content);
      out.push('');
    });
    return out.join('\n');
  }

  function batchExport(text, options) {
    var opt = options || {};
    var generatedAt = opt.generatedAt || new Date().toLocaleString('zh-CN');
    var files = splitDeviceScripts(text).map(function (b) {
      return {
        name: ('0' + b.index).slice(-2) + '_' + safeFileName(b.name) + '.cfg',
        device: b.name,
        content: deviceFileHeader(b, { generatedAt: generatedAt, score: opt.score }) + b.content
      };
    });
    var packageText = buildPackage(files, { generatedAt: generatedAt, score: opt.score });
    return {
      files: files, packageText: packageText,
      packageName: 'openshell-配置包.txt', count: files.length, generatedAt: generatedAt
    };
  }

  /* ==========================================================
     7. 组合入口
     ========================================================== */
  function analyzeAll(graphOrTopology) {
    var t = (graphOrTopology && typeof graphOrTopology.getNodes === 'function')
      ? fromGraph(graphOrTopology) : normalize(graphOrTopology);
    return {
      topology: t,
      stats: summarize(t),
      report: validateConfig(t),
      plan: planIP(t)
    };
  }

  return {
    VERSION: VERSION,
    // IP 工具
    isValidIpv4: isValidIpv4, ipToInt: ipToInt, intToIp: intToIp,
    isValidMask: isValidMask, maskToPrefix: maskToPrefix, prefixToMask: prefixToMask,
    networkOf: networkOf, broadcastOf: broadcastOf, sameSubnet: sameSubnet,
    // 采集 / 规划 / 检测
    normalize: normalize, fromGraph: fromGraph, summarize: summarize, collectVlanMap: collectVlanMap,
    planIP: planIP, autoApplyPlan: autoApplyPlan,
    detectIPConflicts: detectIPConflicts, detectVlanConflicts: detectVlanConflicts,
    validateConfig: validateConfig, formatReport: formatReport,
    // 解释 / 导出
    explainLines: explainLines, explainCommands: explainCommands,
    safeFileName: safeFileName, splitDeviceScripts: splitDeviceScripts,
    deviceFileHeader: deviceFileHeader, buildPackage: buildPackage, batchExport: batchExport,
    // 组合
    analyzeAll: analyzeAll
  };
});
