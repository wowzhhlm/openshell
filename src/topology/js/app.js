/* ============================================================
   app.js — 应用入口
   初始化 G6 图引擎 / 右侧面板 / 工具栏 / 快捷键
   ============================================================ */

(function() {
  'use strict';

  function bootstrap() {
    if (typeof G6 === 'undefined') {
      document.body.innerHTML =
        '<div style="padding:40px;text-align:center;color:#EF4444;font-family:sans-serif;">' +
        '<h2>G6 加载失败</h2><p>请检查网络连接，确保可以访问 CDN。</p>' +
        '<p><code>https://unpkg.com/@antv/g6@4.8.24/dist/g6.min.js</code></p></div>';
      return;
    }

    // 1. 初始化 G6 图引擎 + 面板拖拽
    var g = initG6('diagram-container');
    if (!g) {
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#EF4444;">未能初始化画布容器</div>';
      return;
    }

    // 2. 初始化右侧面板 (填充表单/功能勾选/按钮事件)
    initUIController();

    // 3. 工具栏绑定
    wireToolbar();

    // 4. 键盘快捷键
    wireKeyboard();

    // 调试全局引用

    window.__topoTool = {
      graph: graph,
      clear: toolbarClear,
      export: toolbarExport,
      import: toolbarImport,
      preset: toolbarPreset,
      mode: toolbarToggleMode,
    };
  }

  function wireToolbar() {
    bind('btn-new',          'click', toolbarClear);
    bind('btn-open',         'click', toolbarImport);
    bind('btn-save',         'click', toolbarExport);
    bind('btn-mode-toggle',  'click', toolbarToggleMode);
    bind('btn-connect-mode', 'click', toggleConnectMode);
    bind('btn-delete',       'click', toolbarDelete);
    bind('btn-batch-gen',    'click', toolbarBatchGenerate);
    bind('btn-about',       'click', showAboutModal);

    // 常用案例下拉
    var presetBtn  = document.getElementById('btn-preset');
    var presetMenu = document.getElementById('preset-menu');
    if (presetBtn && presetMenu) {
      presetBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        presetMenu.style.display = presetMenu.style.display === 'block' ? 'none' : 'block';
      });
      document.addEventListener('click', function() { presetMenu.style.display = 'none'; });
      presetMenu.querySelectorAll('.preset-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
          e.stopPropagation();
          var key = item.getAttribute('data-preset');
          if (key) toolbarPreset(key);
          presetMenu.style.display = 'none';
        });
      });
    }
  }

  function bind(id, event, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  }

  function wireKeyboard() {
    document.addEventListener('keydown', function(e) {
      if (!graph) return;

      // Delete / Backspace — 删除选中连线 或 批量删除选中设备
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input,textarea,select')) {
        e.preventDefault();
        var selEdges = graph.findAllByState('edge', 'selected');
        if (selEdges.length > 0) {
          selEdges.forEach(function(edge) { graph.removeItem(edge); });
        } else {
          deleteSelectedNodes();
        }
        if (typeof onDiagramSelectionChanged === 'function') onDiagramSelectionChanged();
      }

      // Ctrl+G — 快捷生成当前设备命令
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        var sel = graph.findAllByState('node', 'selected');
        if (sel.length === 1) { generateForNode(sel[0]); }
        else if (sel.length > 1) { alert('请只选中一台设备来生成命令。'); }
        else { alert('请先选中一台设备。'); }
      }

      // 撤销
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo(graph);
      }

      // 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        toolbarExport();
      }

      // Escape 取消选择 + 退出连线模式
      if (e.key === 'Escape') {
        _exitConnectingMode();
        graph.getNodes().forEach(function(n) { graph.setItemState(n, 'selected', false); });
        graph.getEdges().forEach(function(e) { graph.setItemState(e, 'selected', false); });
        if (typeof onDiagramSelectionChanged === 'function') onDiagramSelectionChanged();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
