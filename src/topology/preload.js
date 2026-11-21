/* ============================================================
   topology/preload.js — 拓扑窗口最小权限桥
   ------------------------------------------------------------
   只暴露一个能力：把智能面板生成的配置包写入 D:\openshell\导出
   渲染层无 Node / fs / path 权限，文件名与内容由主进程再次校验。
   ============================================================ */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('topoApi', {
  saveConfigPackage: (payload) => ipcRenderer.invoke('topology:saveConfigPackage', payload)
});
