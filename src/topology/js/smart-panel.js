/* ============================================================
   smart-panel.js — 智能配置分析面板（OpenShell 网络版自研 UI 接入层）
   ------------------------------------------------------------
   · 以「附加」方式接入，不修改第三方 app.js / ui-controller.js 的原有逻辑
   · 依赖：SmartConfig（smart-config.js）、window.__topoTool.graph、CmdTpl
   · 可选依赖：window.topoApi（拓扑窗口 preload，用于把配置包写入 D 盘）
   ============================================================ */
(function () {
  'use strict';

  var SC = window.SmartConfig;
  if (!SC) { console.error('[SmartPanel] SmartConfig 未加载'); return; }

  var last = null;
  var currentTab = 'issues';

  function getGraph() { return window.__topoTool && window.__topoTool.graph; }

  function generateAllText() {
    try {
      if (typeof CmdTpl !== 'undefined' && CmdTpl && CmdTpl.generateAll) {
        var g = getGraph();
        return g ? CmdTpl.generateAll(g) : '';
      }
    } catch (e) { console.error('[SmartPanel] generateAll 失败', e); }
    return '';
  }

  function currentVendor() {
    var t = last && last.topology;
    if (!t) return '';
    for (var i = 0; i < t.devices.length; i++) if (t.devices[i].vendor) return t.devices[i].vendor;
    return '';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  /* ---------------- 样式（附加式注入） ---------------- */
  function injectCss() {
    if (document.getElementById('smart-panel-css')) return;
    var css = [
      '.sp-overlay{position:fixed;inset:0;background:rgba(4,10,20,.78);z-index:9000;display:flex;align-items:center;justify-content:center;}',
      '.sp-box{width:min(1080px,94vw);height:min(760px,92vh);background:#0E1B2E;color:#E2EAF4;border:1px solid #2A4A72;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.6);display:flex;flex-direction:column;font-family:"Microsoft YaHei",system-ui,sans-serif;}',
      '.sp-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #23406A;font-size:16px;font-weight:700;}',
      '.sp-head button{background:transparent;border:0;color:#9FB4CE;font-size:18px;cursor:pointer;}',
      '.sp-stats{display:flex;flex-wrap:wrap;gap:10px;padding:12px 18px;background:#12233C;border-bottom:1px solid #23406A;}',
      '.sp-stat{background:#172E4D;border:1px solid #2A4A72;border-radius:6px;padding:7px 12px;font-size:12px;}',
      '.sp-stat b{color:#5FD3F3;font-size:16px;margin-right:5px;}',
      '.sp-score{margin-left:auto;font-size:14px;padding:6px 14px;border-radius:6px;background:#173B34;border:1px solid #2E7D6B;}',
      '.sp-score.bad{background:#45202A;border-color:#8B3A4A;}',
      '.sp-score.mid{background:#453A1C;border-color:#8A712F;}',
      '.sp-tabs{display:flex;gap:4px;padding:10px 18px 0;border-bottom:1px solid #23406A;}',
      '.sp-tabs button{background:transparent;border:1px solid transparent;border-bottom:0;color:#9FB4CE;padding:8px 16px;cursor:pointer;border-radius:6px 6px 0 0;font-size:13px;}',
      '.sp-tabs button.active{background:#172E4D;color:#7FE0FF;border-color:#2A4A72;font-weight:700;}',
      '.sp-body{flex:1;overflow:auto;padding:14px 18px;}',
      '.sp-pane{display:none;} .sp-pane.active{display:block;}',
      '.sp-issue{border-left:3px solid #3A5680;background:#14263F;margin:0 0 8px;padding:9px 12px;border-radius:0 5px 5px 0;font-size:13px;}',
      '.sp-issue.error{border-left-color:#EF5350;background:#2A1822;}',
      '.sp-issue.warn{border-left-color:#F5A623;background:#2A2417;}',
      '.sp-issue.info{border-left-color:#4B9BE8;}',
      '.sp-issue .sp-tag{display:inline-block;min-width:34px;font-weight:700;margin-right:8px;}',
      '.sp-issue .sp-dev{color:#8FD8FF;margin-right:8px;}',
      '.sp-issue .sp-fix{display:block;margin-top:4px;color:#A9BBD0;font-size:12px;}',
      '.sp-table{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0 16px;}',
      '.sp-table th,.sp-table td{border:1px solid #2A4A72;padding:6px 9px;text-align:left;vertical-align:top;}',
      '.sp-table th{background:#172E4D;color:#9FD8FF;white-space:nowrap;}',
      '.sp-table td{color:#D5E1EF;}',
      '.sp-h3{font-size:13px;color:#9FD8FF;margin:14px 0 6px;font-weight:700;}',
      '.sp-btn{background:#1B4C7A;border:1px solid #3D7FB8;color:#DCEBFA;padding:7px 14px;border-radius:5px;cursor:pointer;font-size:12px;margin:4px 6px 4px 0;}',
      '.sp-btn:hover{background:#23619B;}',
      '.sp-btn.primary{background:#167A6A;border-color:#2EB69C;color:#E6FFFA;}',
      '.sp-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.sp-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 18px;border-top:1px solid #23406A;font-size:12px;color:#A9BBD0;}',
      '.sp-foot label{cursor:pointer;}',
      '.sp-foot .sp-right{margin-left:auto;display:flex;gap:6px;}',
      '.sp-note{color:#8FA6C0;font-size:12px;line-height:1.7;}',
      '.sp-explain-row{display:flex;gap:12px;padding:3px 0;font-size:12px;font-family:Consolas,monospace;border-bottom:1px solid #1C3352;}',
      '.sp-explain-row .cmd{color:#A8E6A0;min-width:46%;white-space:pre-wrap;word-break:break-all;}',
      '.sp-explain-row .note{color:#9FB4CE;flex:1;}',
      '.sp-precheck-inline{display:block;color:#F5C26B;background:#2A2417;border-left:3px solid #F5A623;padding:8px 10px;margin-bottom:10px;white-space:pre-wrap;font-family:Consolas,monospace;font-size:12px;}',
      '.sp-explain-note{display:block;color:#7FA8C8;font-size:12px;padding-left:14px;}',
      '.sp-result{margin-top:10px;padding:9px 12px;background:#173B34;border:1px solid #2E7D6B;border-radius:5px;color:#CFF7EC;font-size:12px;white-space:pre-wrap;}',
      '.sp-result.err{background:#45202A;border-color:#8B3A4A;color:#FFD9DE;}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'smart-panel-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- 面板 DOM ---------------- */
  function buildPanel() {
    if (document.getElementById('smart-overlay')) return;
    var ov = el('div', 'sp-overlay');
    ov.id = 'smart-overlay';
    ov.style.display = 'none';
    var box = el('div', 'sp-box');
    var head = el('div', 'sp-head');
    head.appendChild(el('span', '', '🧠 智能配置分析 · OpenShell 网络版'));
    var close = el('button', '', '✕'); close.id = 'sp-close'; close.title = '关闭';
    head.appendChild(close);
    box.appendChild(head);

    var stats = el('div', 'sp-stats'); stats.id = 'sp-stats';
    box.appendChild(stats);

    var tabs = el('div', 'sp-tabs');
    [['issues', '🩺 体检报告'], ['plan', '🌐 IP / VLAN 规划'], ['explain', '📖 命令解释'], ['export', '🗂 批量导出']]
      .forEach(function (t) {
        var b = el('button', t[0] === currentTab ? 'active' : '', t[1]);
        b.setAttribute('data-tab', t[0]);
        tabs.appendChild(b);
      });
    box.appendChild(tabs);

    var body = el('div', 'sp-body');
    ['issues', 'plan', 'explain', 'export'].forEach(function (k) {
      var p = el('div', 'sp-pane' + (k === currentTab ? ' active' : ''));
      p.id = 'sp-tab-' + k;
      body.appendChild(p);
    });
    box.appendChild(body);

    var foot = el('div', 'sp-foot');
    var lab1 = el('label'); var cb1 = document.createElement('input');
    cb1.type = 'checkbox'; cb1.id = 'sp-precheck'; cb1.checked = true;
    lab1.appendChild(cb1); lab1.appendChild(document.createTextNode(' 批量生成时附带体检'));
    var lab2 = el('label'); var cb2 = document.createElement('input');
    cb2.type = 'checkbox'; cb2.id = 'sp-explain-mode';
    lab2.appendChild(cb2); lab2.appendChild(document.createTextNode(' 批量生成时逐行解释'));
    foot.appendChild(lab1); foot.appendChild(lab2);
    var right = el('div', 'sp-right');
    var refresh = el('button', 'sp-btn', '🔄 重新体检'); refresh.id = 'sp-refresh';
    var close2 = el('button', 'sp-btn', '关闭'); close2.id = 'sp-close2';
    right.appendChild(refresh); right.appendChild(close2);
    foot.appendChild(right);
    box.appendChild(foot);
    ov.appendChild(box);
    document.body.appendChild(ov);

    close.onclick = close2.onclick = hidePanel;
    ov.addEventListener('click', function (e) { if (e.target === ov) hidePanel(); });
    refresh.onclick = function () { last = null; runAnalysis(true); };
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-tab]') : null;
      if (!b) return;
      switchTab(b.getAttribute('data-tab'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.style.display === 'flex') hidePanel();
    });
  }

  function switchTab(k) {
    currentTab = k;
    var tabs = document.querySelectorAll('#smart-overlay .sp-tabs button');
    Array.prototype.forEach.call(tabs, function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === k);
    });
    ['issues', 'plan', 'explain', 'export'].forEach(function (x) {
      var p = document.getElementById('sp-tab-' + x);
      if (p) p.classList.toggle('active', x === k);
    });
    renderTab(k);
  }

  function showPanel(tab) {
    buildPanel();
    var ov = document.getElementById('smart-overlay');
    ov.style.display = 'flex';
    runAnalysis(false);
    switchTab(tab || 'issues');
  }
  function hidePanel() {
    var ov = document.getElementById('smart-overlay');
    if (ov) ov.style.display = 'none';
  }

  /* ---------------- 分析 ---------------- */
  function ensureAnalysis() {
    if (!last) {
      var g = getGraph();
      last = SC.analyzeAll(g);
    }
    return last;
  }

  function runAnalysis(force) {
    if (force) last = null;
    var a = ensureAnalysis();
    renderStats(a);
    renderTab(currentTab);
    return a;
  }

  function renderStats(a) {
    var box = document.getElementById('sp-stats');
    if (!box) return;
    box.textContent = '';
    var s = a.stats;
    [['设备', s.devices], ['交换机', s.switches], ['路由器', s.routers], ['终端', s.endpoints],
     ['VLAN', s.vlans], ['连线', s.edges], ['已配 IP', s.withIp], ['未选厂商', s.withoutVendor]]
      .forEach(function (p) {
        var d = el('div', 'sp-stat');
        d.appendChild(el('b', '', p[1]));
        d.appendChild(document.createTextNode(p[0]));
        box.appendChild(d);
      });
    var r = a.report;
    var cls = r.level === 'error' ? 'bad' : (r.level === 'warn' ? 'mid' : '');
    var score = el('div', 'sp-score ' + cls, '体检 ' + r.score + '/100  ·  错误 ' + r.counts.error + ' / 警告 ' + r.counts.warn + ' / 提示 ' + r.counts.info);
    box.appendChild(score);
  }

  function renderTab(k) {
    if (k === 'issues') renderIssues();
    else if (k === 'plan') renderPlan();
    else if (k === 'explain') renderExplain();
    else if (k === 'export') renderExport();
  }

  function renderIssues() {
    var pane = document.getElementById('sp-tab-issues');
    if (!pane) return;
    pane.textContent = '';
    var a = ensureAnalysis(), r = a.report;
    var tip = el('div', 'sp-note');
    tip.textContent = ({ error: '存在必须修复的错误，修正后再生成并下发配置。', warn: '存在风险项，建议按下列建议修复后下发。',
      info: '配置基本可用，以下是优化建议。', ok: '未发现配置问题。' }[r.level] || '');
    pane.appendChild(tip);
    if (!r.issues.length) { pane.appendChild(el('div', 'sp-result', '✅ 未发现问题项')); return; }
    var label = { error: '错误', warn: '警告', info: '提示' };
    r.issues.forEach(function (it) {
      var d = el('div', 'sp-issue ' + it.severity);
      var line = el('div');
      line.appendChild(el('span', 'sp-tag', '[' + (label[it.severity] || it.severity) + ']'));
      line.appendChild(el('span', 'sp-dev', it.device || '—'));
      line.appendChild(document.createTextNode(it.message));
      d.appendChild(line);
      if (it.suggestion) d.appendChild(el('span', 'sp-fix', '→ ' + it.suggestion));
      pane.appendChild(d);
    });
    var btn = el('button', 'sp-btn primary', '📋 复制体检报告');
    btn.onclick = function () {
      copyText(SC.formatReport(r), btn);
    };
    pane.appendChild(btn);
  }

  function renderPlan() {
    var pane = document.getElementById('sp-tab-plan');
    if (!pane) return;
    pane.textContent = '';
    var a = ensureAnalysis(), p = a.plan;
    pane.appendChild(el('div', 'sp-note',
      '按 VLAN 自动规划 10.' + p.site + '.<VLAN>.0/24 网段，网关 .1，设备从 .10 起；已填写的地址不会被覆盖。' +
      '管理 VLAN = ' + p.mgmtVlan + '。点击「应用规划到画布」可把建议写回设备，之后请重新生成命令。'));

    pane.appendChild(el('div', 'sp-h3', '① VLAN 网段规划（' + p.subnets.length + ' 个）'));
    var t1 = el('table', 'sp-table');
    var h1 = el('tr');
    ['VLAN', '网段', '掩码', '网关', '建议主机范围'].forEach(function (x) { h1.appendChild(el('th', '', x)); });
    t1.appendChild(h1);
    p.subnets.forEach(function (s) {
      var tr = el('tr');
      [s.vlan, s.network + '/' + s.prefix, s.mask, s.gateway, s.suggestedRange]
        .forEach(function (x) { tr.appendChild(el('td', '', x)); });
      t1.appendChild(tr);
    });
    pane.appendChild(t1);

    pane.appendChild(el('div', 'sp-h3', '② 待回填项（' + p.assignments.length + ' 条）'));
    if (!p.assignments.length) {
      pane.appendChild(el('div', 'sp-note', '当前没有需要自动补齐的地址，所有设备已配置 IP / 网关。'));
    } else {
      var t2 = el('table', 'sp-table');
      var h2 = el('tr');
      ['设备', '字段', '建议值', '依据'].forEach(function (x) { h2.appendChild(el('th', '', x)); });
      t2.appendChild(h2);
      p.assignments.forEach(function (x) {
        var tr = el('tr');
        [x.device, x.field, x.value, x.reason].forEach(function (v) { tr.appendChild(el('td', '', v)); });
        t2.appendChild(tr);
      });
      pane.appendChild(t2);
    }

    var apply = el('button', 'sp-btn primary', '⬇ 应用规划到画布');
    apply.disabled = !p.assignments.length;
    apply.onclick = function () {
      var n = applyPatches(p);
      last = null;
      runAnalysis(true);
      switchTab('plan');
      var res = el('div', 'sp-result', '已写回 ' + n + ' 台设备的配置，请重新点击「⚡ 批量生成」刷新命令。');
      pane.appendChild(res);
    };
    pane.appendChild(apply);
  }

  function applyPatches(plan) {
    var g = getGraph();
    if (!g || !g.findById) return 0;
    var a = ensureAnalysis();
    var patches = SC.autoApplyPlan(a.topology, plan);
    var n = 0;
    Object.keys(patches).forEach(function (id) {
      var item = g.findById(id);
      if (!item) return;
      try {
        var model = item.getModel();
        var data = Object.assign({}, model.data || {}, patches[id]);
        g.updateItem(item, { data: data });
        n++;
      } catch (e) { console.error('[SmartPanel] updateItem 失败', id, e); }
    });
    return n;
  }

  function renderExplain() {
    var pane = document.getElementById('sp-tab-explain');
    if (!pane) return;
    pane.textContent = '';
    var vendor = currentVendor();
    pane.appendChild(el('div', 'sp-note', '命令逐行中文解释（厂商：' + (vendor || '自动') + '）。这是阅读版，请勿直接下发；下发前删除所有「!」注释行。'));
    var text = generateAllText();
    if (!text) { pane.appendChild(el('div', 'sp-result err', '未能生成命令，请先在画布中添加设备并连线。')); return; }
    var rows = SC.explainLines(text, vendor).filter(function (l) { return l.kind !== 'blank'; });
    var shown = 0;
    rows.forEach(function (l) {
      if (shown >= 500) return;
      if (l.kind === 'comment' && !l.note) return;   // 跳过纯注释横幅
      var row = el('div', 'sp-explain-row');
      row.appendChild(el('div', 'cmd', l.cmd));
      row.appendChild(el('div', 'note', l.note || '—'));
      pane.appendChild(row);
      shown++;
    });
    var btn = el('button', 'sp-btn primary', '📋 复制解释版（阅读用）');
    btn.onclick = function () { copyText(SC.explainCommands(text, vendor), btn); };
    pane.appendChild(btn);
  }

  function renderExport() {
    var pane = document.getElementById('sp-tab-export');
    if (!pane) return;
    pane.textContent = '';
    var a = ensureAnalysis();
    pane.appendChild(el('div', 'sp-note',
      '把批量生成的命令按设备拆成独立 .cfg 配置文件，并附合并配置包与清单。' +
      '保存到 D 盘时会写入 D:\\openshell-network\\导出\\配置包_<时间>\\。请务必人工复核后再下发。'));
    var text = generateAllText();
    if (!text) { pane.appendChild(el('div', 'sp-result err', '未能生成命令，请先在画布中添加设备并连线。')); return; }
    var pkg = SC.batchExport(text, { score: a.report.score });
    if (!pkg.count) {
      pane.appendChild(el('div', 'sp-result err',
        '未生成任何设备配置命令。请确认设备已选择厂商、类型为交换机/路由器（终端与监控设备不生成 CLI），然后点击「⚡ 批量生成」后重试。'));
      return;
    }
    pane.appendChild(el('div', 'sp-h3', '配置文件清单（' + pkg.count + ' 个）'));
    var t = el('table', 'sp-table');
    var h = el('tr'); ['文件名', '设备', '行数'].forEach(function (x) { h.appendChild(el('th', '', x)); });
    t.appendChild(h);
    pkg.files.forEach(function (f) {
      var tr = el('tr');
      [f.name, f.device, f.content.split('\n').length].forEach(function (v) { tr.appendChild(el('td', '', v)); });
      t.appendChild(tr);
    });
    pane.appendChild(t);

    var save = el('button', 'sp-btn primary', '💾 保存全部到 D:\\openshell-network\\导出');
    save.onclick = function () { doSave(pkg, pane, save); };
    pane.appendChild(save);
    var dl = el('button', 'sp-btn', '⬇ 下载合并配置包');
    dl.onclick = function () { downloadText(pkg.packageText, pkg.packageName); };
    pane.appendChild(dl);
  }

  function doSave(pkg, pane, btn) {
    var old = pane.querySelector('.sp-result');
    if (old) old.parentNode.removeChild(old);
    var res = el('div', 'sp-result', '正在写入…');
    pane.appendChild(res);
    var payload = {
      files: pkg.files.map(function (f) { return { name: f.name, content: f.content, device: f.device }; }),
      packageName: pkg.packageName, packageText: pkg.packageText,
      generatedAt: pkg.generatedAt, score: null
    };
    var api = window.topoApi;
    if (!api || !api.saveConfigPackage) {
      res.className = 'sp-result err';
      res.textContent = '当前窗口未提供文件写入接口，已改为浏览器下载合并包。';
      downloadText(pkg.packageText, pkg.packageName);
      return;
    }
    Promise.resolve(api.saveConfigPackage(payload)).then(function (r) {
      if (r && r.ok) {
        res.className = 'sp-result';
        res.textContent = '✅ 已写入 ' + r.written.length + ' 个文件\n目录：' + r.dir +
          '\n文件：' + r.written.join('、');
      } else {
        res.className = 'sp-result err';
        res.textContent = '保存失败：' + ((r && r.error) || '未知错误');
      }
    }).catch(function (e) {
      res.className = 'sp-result err';
      res.textContent = '保存失败：' + (e && e.message ? e.message : e);
    });
  }

  function downloadText(text, name) {
    try {
      var blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name || 'openshell-配置包.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 2000);
    } catch (e) { alert('下载失败：' + e.message); }
  }

  function copyText(text, btn) {
    var old = btn.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text || '')).then(function () {
        btn.textContent = '✅ 已复制'; setTimeout(function () { btn.textContent = old; }, 1500);
      }).catch(function () { alert('复制失败，请手动选择文本后 Ctrl+C 复制。'); });
    } else alert('当前环境不支持剪贴板，请手动选择文本后 Ctrl+C 复制。');
  }

  /* ---------------- 批量生成的后置增强 ---------------- */
  function enhanceBatchOutput() {
    var batchBtn = document.getElementById('btn-batch-gen');
    if (!batchBtn) return;
    batchBtn.addEventListener('click', function () {
      setTimeout(function () {
        var overlay = document.getElementById('terminal-modal');
        var body = document.getElementById('terminal-body');
        if (!overlay || overlay.style.display !== 'flex' || !body) return;
        var pre = document.getElementById('sp-precheck');
        if (pre && pre.checked && !body.querySelector('.sp-precheck-inline')) {
          var a = ensureAnalysis();
          var box = el('div', 'sp-precheck-inline', SC.formatReport(a.report));
          body.insertBefore(box, body.firstChild);
        }
        var ex = document.getElementById('sp-explain-mode');
        if (ex && ex.checked) {
          var vendor = currentVendor();
          Array.prototype.forEach.call(body.querySelectorAll('.t-cmd'), function (span) {
            var cmd = span.textContent.trim();
            var hit = SC.explainLines(cmd, vendor).filter(function (l) { return l.note; })[0];
            if (!hit) return;
            var note = el('span', 'sp-explain-note', '!   → ' + hit.note);
            if (span.insertAdjacentElement) span.insertAdjacentElement('afterend', note);
            else span.parentNode.insertBefore(note, span.nextSibling);
          });
        }
      }, 0);
    });
  }

  /* ---------------- 工具栏入口 ---------------- */
  function injectToolbarButtons() {
    var toolbar = document.getElementById('toolbar');
    if (!toolbar || document.getElementById('sp-btn-check')) return;
    var group = el('div', 'toolbar-group');
    var b1 = el('button', '', '🧠 智能体检');
    b1.id = 'sp-btn-check'; b1.title = '配置体检 / IP 规划 / 命令解释 / 批量导出';
    b1.onclick = function () { showPanel('issues'); };
    var b2 = el('button', '', '🗂 批量导出');
    b2.id = 'sp-btn-export'; b2.title = '按设备导出独立配置文件到 D 盘';
    b2.onclick = function () { showPanel('export'); };
    group.appendChild(b1); group.appendChild(b2);
    var batch = document.getElementById('btn-batch-gen');
    if (batch && batch.parentNode) batch.parentNode.insertBefore(group, batch.nextSibling);
    else toolbar.appendChild(group);
  }

  /* ---------------- 启动（等待 app.js 的 bootstrap 完成） ---------------- */
  function init() {
    injectCss();
    injectToolbarButtons();
    buildPanel();
    enhanceBatchOutput();
  }
  function waitAndInit(tries) {
    if (document.getElementById('toolbar') && (document.readyState === 'complete' || window.__topoTool)) {
      init(); return;
    }
    if (tries <= 0) { init(); return; }
    setTimeout(function () { waitAndInit(tries - 1); }, 100);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { waitAndInit(30); });
  } else {
    waitAndInit(30);
  }
})();
