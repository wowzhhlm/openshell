# OpenShell 网络版（OpenShell Network）

开源、轻量、无需注册且无有效期的**多协议终端客户端 + 网络拓扑配置工具**。

这是 OpenShell 的独立新版本（v2.0.0），与旧版 `D:\openshell`（v1.4.x）完全分离，拥有独立的代码仓库、应用标识与数据目录。本项目为从零实现的干净房间（clean-room）客户端，不使用 Xshell / SecureCRT 的代码、签名、品牌资源或任何专有组件。

## 核心功能

### 1. 九种协议终端
- **SSH**：多标签终端（xterm.js 渲染，密码 / 私钥认证、窗口自适应、主机密钥校验）
- **Telnet**：明文远程登录，可选自动登录
- **RLOGIN**：明文远程登录（RFC 1258，端口 513）
- **SFTP**：加密文件传输（独立模式 + 侧边面板，上传 / 下载 / 删除）
- **FTP**：传统文件传输（端口 21，被动模式，列目录 / 上传 / 下载 / 删除）
- **RDP**：Windows 远程桌面图形协议，一键调用系统“远程桌面连接”
- **Serial 串口**：基于 Web Serial API，115200 8N1
- **Local 本地终端**：在本机启动系统 Shell（Windows cmd）
- **Raw 原始 TCP**：裸连接字符透传

### 2. 主密码保险库（密码导出 / 导入）
- 导出 OpenShell JSON 时**默认导出密码**：先验证工具主密码，再用主密码（`scrypt` 派生密钥 + `AES-256-GCM` 认证加密）把密码字典加密进会话文件。
- **仅当两台电脑主密码相同**时，导入才能还原密码——加密数据自带随机 salt，不依赖本机状态。
- **清除密码选项**：导出区域提供“导出密码（用主密码加密）”复选框，可取消勾选以不导出任何密码，用户自主选择。
- 主密码仅在本地保存校验串（同样加密），不明文存储、无法找回。
- 第三方格式（Xshell / SecureCRT）为私有加密，仍不写入密码。

### 3. Linux 命令中文查询
- 内置 69 条常用命令，涵盖文件目录、文件内容、系统监控、网络、权限、进程服务、压缩归档、文本处理等分类。
- 每条含：功能说明、语法、常用参数、实测示例。支持按命令名 / 功能 / 分类 / 参数离线搜索。

### 4. 网络拓扑与交换机配置自动生成
- **自定义绘制拓扑**：拖拽交换机 / 路由器 / 终端等设备安装、连线、配置接口 / VLAN / IP。
- **自动生成配置**：根据拓扑批量生成多品牌 CLI 命令，支持 **华为（VRP）、思科（IOS）、H3C（Comware）、锐捷、TP-LINK**；覆盖 VLAN、Trunk、VLANIF、静态路由等场景。
- **导出脚本 / 配置文件**：生成的命令可直接复制或导出为文本文件。
- **一键下发**：通过已有 SSH 会话，把配置自动下发到交换机并保存（工具菜单“下发配置到交换机”）。
- 拓扑引擎基于开源项目 [net-topo-cmd-generator-web](https://github.com/bobhe2016/net-topo-cmd-generator-web)（MIT），已本地化依赖，离线可用。

### 5. 会话管理与通用能力
- 分组、搜索、右键编辑 / 复制 / 删除；顶部全中文菜单（文件 / 编辑 / 会话 / 工具 / 视图 / 帮助）。
- 批量导入 / 导出（多文件、目录递归，最多 500 个文件 / 单个 2MB）。
- 跨客户端迁移：导入 Xshell `.xsh`（INI/XML）、SecureCRT `.ini`、OpenShell JSON。
- 端口转发、脚本发送、多主题（深空蓝默认 / 浅色 / Solarized）、字体与回滚行数可调。
- **终端右键菜单**：终端内右键可「复制选中 / 粘贴 / 全选 / 清空终端 / 重新连接」；快捷键 `Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 粘贴、`Ctrl+Shift+A` 全选；设置中可开启「鼠标选中即复制」。
- **连接原标签重试**：连接失败后标签保留并显示原因，再次连接同一会话或右键「重新连接」会在原标签清空重试，不另开新标签。
- **SSH 算法兼容**：显式声明 14 种密钥交换算法 + 12 种加密套件 + 8 种主机密钥算法（现代优先、旧算法兜底），兼容只支持 `diffie-hellman-group14-sha1` / `aes128-cbc` / `ssh-rsa` 的老旧服务器，解决 `no matching key exchange algorithm` 握手失败。
- 导出位置自选（系统目录选择对话框）。

## 安全设计

- **最小权限渲染进程**：`contextIsolation: true` + `nodeIntegration: false`，渲染层无法直接访问 Node / 文件系统 / 网络；敏感操作经 `preload.js` 白名单 IPC 由主进程执行。
- **凭据加密**：密码与密钥口令使用 Electron `safeStorage`（Windows DPAPI）加密保存，**不写入会话文件**。
- **主密码加密导出**：导出密码用 `scrypt`（N=16384）+ `AES-256-GCM`，salt 随数据走，密码错误 / 数据篡改均无法解密。
- **主机密钥校验**：首次连接显示 SHA-256 指纹并要求人工确认，写入 `known_hosts.json`，防范中间人攻击。
- **严格 CSP**：禁止外部脚本与远程连接，页面仅加载本地资源（G6 已本地化，无 CDN 依赖）。
- **输入安全**：动态文本使用 `textContent` 写入，不以 `innerHTML` 拼接用户 / 远程数据。

> 明文协议（Telnet / RLOGIN / FTP）凭据可能被网络监听，敏感场景请使用 SSH / SFTP。

## 目录与数据

- 源码与生成结果根目录：`D:\openshell-network\`
- 输出目录：`D:\openshell-network\导出`、`下载`、`报告`
- 便携模式：程序目录存在 `portable.txt` 时，数据写入程序同级的 `OpenShell网络版数据\`，全套目录复制到 U 盘即可换机使用。
- 用户配置：`%APPDATA%\openshell-network`（标准模式）/ 程序目录（便携模式）

## 运行

环境：Node.js ≥ 22.12、Windows x64。

```bash
npm install
npm start
```

测试：

```bash
npm test          # 格式 + Telnet + 新功能 + 保险库
node test-vault.js
```

打包便携版：

```bash
npm run dist
```

## 开源组件

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| Electron 45 | 桌面运行时 | MIT |
| xterm.js 6 | 终端渲染 | MIT |
| ssh2 1.17 | SSH / SFTP | MIT |
| AntV G6 4.8 | 拓扑图绘制 | MIT |
| net-topo-cmd-generator-web | 拓扑配置生成引擎（集成并改进） | MIT |

## 许可证

MIT
