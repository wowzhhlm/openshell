# 第三方组件与合规说明（拓扑模块）

本文件记录 `src/topology/` 内所有第三方代码的来源、许可证状态与本项目的处置措施。
分发二进制前请先阅读第 2 节的风险提示。

---

## 1. 组件清单

| 组件 | 版本 / 来源 | 用途 | 许可证 | 状态 |
| --- | --- | --- | --- | --- |
| AntV G6 | 4.8.x，`vendor/g6.min.js`（本地化，原 CDN `@antv/g6@4.8.24`） | 拓扑画布绘制 | MIT | ✅ 可分发；保留文件内版权头 |
| net-topo-cmd-generator-web | `bobhe2016/net-topo-cmd-generator-web`，`js/*.js`、`js/templates/*.js`、`css/style.css`、`index.html` | 拓扑分析与多厂商 CLI 模板 | ⚠️ **见第 2 节** | ⚠️ 待补授权 |
| Electron / xterm.js / ssh2 | 见根目录 README 开源组件表 | 宿主 / 终端 / SSH | MIT | ✅ |
| smart-config.js / smart-panel.js / preload.js | **本项目自研** | 智能体检、IP 规划、命令解释、批量导出、文件写入 | MIT（随本项目） | ✅ 不含第三方代码 |

---

## 2. ⚠️ net-topo-cmd-generator-web 许可证风险

### 核查结果

- 仓库 README 中写有「MIT」字样；
- **GitHub API 返回 `license: null`**；
- **仓库根目录没有 `LICENSE` / `COPYING` 文件**；
- 原仓库未附作者联系方式或书面授权文件。

### 法律含义（一般性说明，非法律意见）

开源社区惯例是：只有 README 中的口头声明、而没有 LICENSE 文件时，**不能当然认定代码已按 MIT 授权**。按著作权默认规则，缺少明确许可证的代码应视为「保留所有权利」。把它打包进可分发的桌面应用存在授权瑕疵。

### 本项目已采取的措施

1. **记录与标注**：本文件如实记录来源与许可证缺口，不声称已获得 MIT 授权。
2. **隔离边界**：所有新增智能化功能（`smart-config.js`、`smart-panel.js`）均为自研，不复制该项目的实现代码；仅通过公开 API（`analyzeTopology()`、`CmdTpl.generateAll()`）调用其能力。
3. **移除不可审计代码**：删除原 `app.js` 中内嵌的混淆 boot loader（`atob` + XOR，66752 字符单行），静态解码确认其功能是注入第三方收款二维码；混淆代码与本项目的「可审计 / 严格 CSP」承诺冲突。
4. **移除第三方变现内容**：删除左侧「支持工具」打赏区块、关于弹窗收款码与悬停放大弹层，替换为中性的「关于本工具」说明。本项目不展示、不导流任何第三方收款信息。
5. **保持本地化**：G6 已改用 `vendor/g6.min.js`，无 CDN、无外部请求。

### 给使用者的建议

- **个人 / 内部使用**：按现状可使用，但请知悉上述授权瑕疵。
- **公开分发 / 商业使用**：在分发前，建议二选一：
  - (a) 联系原作者取得书面 MIT 授权，或请其在仓库补齐 `LICENSE` 文件；
  - (b) 执行 `报告\拓扑引擎评估与升级方案.md` 中的 **Phase 2**：用自研 YAML 模板引擎替换 `js/templates/*` 与 `analyzer.js`，彻底移除该依赖。
- 无论选择哪条路径，都**不要**把本模块单独声称为 MIT 授权代码。

---

## 3. 已明确排除的候选项目（不得引入）

| 项目 | 排除原因 |
| --- | --- |
| NetSim Studio / 其镜像（faawrqweqw 等） | 原仓库与作者 404，镜像无 LICENSE，代码来源不明；且需 Vite + Express + ssh2 + ws 后端 |
| itsbrunodev/nwiz | GPL-3.0（与本项目 MIT 分发冲突）、Tauri 非 Web 无法内嵌、仅支持 Cisco |
| NetBox / Batfish / netmiko / NAPALM / Nornir / containerlab / GNS3 | 需 Python/Java 后端或服务，赛道不符；仅可作为未来**独立可选服务**对接，不得复制代码进本仓库 |
| diagrams.net (drawio) | 仅绘图，无 CLI 生成能力；若未来引入需按 Apache-2.0 单独处理 NOTICE |

> 详细对比与 star 数据见 `报告\拓扑引擎评估与升级方案.md`。

---

## 4. 混淆 boot loader 处置记录（可复核）

- 位置：`src/topology/js/app.js` 原第 36–37 行（`(function(){var k="NetTopo2026";var d=atob("…")…})();`）。
- 解码方式：base64 解码后逐字节与密钥 `NetTopo2026` 做 XOR，结果拼为 `data:image/jpeg;base64,…`。
- 行为：把该 JPEG 设置为 `donate-qr` / `about-qr` 图片，并为打赏区块绑定 hover 弹层。
- 判定：不是远程加载器、不发起网络请求，但属于**不可审计的混淆代码 + 第三方收款内容**。
- 处置：**整行删除**，同时删除对应 DOM 区块；`window.__topoTool`、`bootstrap()` 等原有逻辑不受影响。

---

## 5. 维护约定

- 新增第三方代码前，先在本文件登记来源、许可证文件是否存在、许可证全文路径。
- 不接受「仅 README 声明许可证」的组件进入可分发路径；如确需引入，须先取得书面授权或完成自研替换。
- 每次重新打包便携版前，复核本文件与 `报告\拓扑引擎评估与升级方案.md` 的结论是否仍然有效。
