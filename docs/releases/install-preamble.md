# 安装指南 · Installation

> 本段落随每个版本发布，嵌在 Release 正文顶部。完整安装与平台说明见 [docs/guides/installation.md](../guides/installation.md)（含 Android Termux、源码构建、Shell 补全、自动更新）。
>
> This section is published with every release. For the full installation & platform guide (Android Termux, building from source, shell completions, auto-update), see [docs/guides/installation.md](../guides/installation.md).

## 下载哪个文件 · Which file to download

按平台与 CPU 架构选（不确定架构？mac 点左上角苹果菜单「关于本机」；Windows 设置 → 系统 → 系统信息；Linux 终端 `uname -m`）：

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS Apple Silicon（M1/M2/M3/M4） | `Tianshu_<版本>_aarch64.dmg` | 多数现代 Mac |
| macOS Intel | `Tianshu_<版本>_x64.dmg` | 2020 前的 Intel Mac |
| Windows 10（1809+）/ 11 x64 | `Tianshu_<版本>_x64-setup.exe` | 安装向导，自带 WebView2 离线安装包 |
| Linux x86_64 | `Tianshu_<版本>_amd64.AppImage` | 免安装 |
| Linux ARM64（树莓派 64 位等） | `Tianshu_<版本>_aarch64.AppImage` | 免安装 |

CLI 用户也可 `npm install -g tianshu-harness`（需 Node.js ≥ 24），或用[一键安装脚本](../guides/installation.md#方式-b一键安装脚本推荐)。

## macOS 安装步骤

1. 下载 `.dmg` 并双击打开，把 **Tianshu** 拖入「应用程序」文件夹
2. **首次打开**：本包为 ad-hoc 签名、未经 Apple 公证，浏览器下载后首次双击会报「已损坏，无法打开」或「无法验证开发者」。拖入应用程序后，在终端执行一次（移除下载隔离属性）：

   ```bash
   xattr -cr /Applications/Tianshu.app
   ```

3. 之后正常双击启动。若仍被拦：右键 App → 「打开」→ 再点「打开」，或系统设置 → 隐私与安全性 → 底部点「仍要打开」
4. 应用内自动更新不受 Gatekeeper 影响——只需首次手动放行

## Windows 安装步骤

1. 下载 `Tianshu_<版本>_x64-setup.exe`，双击运行，按向导完成安装
2. 界面依赖 **WebView2 Runtime**——3.5.3 起安装器已内嵌离线安装包，通常无需额外操作
3. 窗口完全打不开时：开始菜单「修复 WebView2」，或从本 Release 底部 `windows-repair` 目录双击 `repair-webview2.cmd`，或手动安装 [WebView2 离线安装包](https://go.microsoft.com/fwlink/p/?LinkId=2124703) 后重启

## Linux 安装步骤

1. 按架构下载 AppImage，加执行权限后直接运行：

   ```bash
   chmod +x Tianshu_*_amd64.AppImage   # ARM 设备换成 _aarch64
   ./Tianshu_*_amd64.AppImage
   ```

2. 依赖：glibc ≥ 2.35（Ubuntu 22.04+ / Debian 12+ 等主流发行版）与系统图形栈 `libwebkit2gtk-4.1.so.0` + `libgtk-3.so.0`——多数桌面发行版已自带；精简/服务器版需按发行版安装 webkit2gtk 4.1，缺库时 `ldd Tianshu_*.AppImage` 自查
3. 推荐 X11 会话（Wayland 尚未验证）

## 常见问题

- **mac 提示「已损坏」**：见上方 macOS 步骤 2 的 `xattr` 命令——这是 Gatekeeper 对未公证下载包的标准行为，不是包真坏了
- **Windows 装完提示 `rivet 无法识别`**：新开一个终端（旧终端的 PATH 是装 Node 之前快照的）
- **Linux AppImage 双击无反应**：先确认执行权限（`chmod +x`），再 `ldd` 查缺库
- **自动更新**：桌面端应用内自动更新（mac Gatekeeper 仅影响首次手动安装）；已安装用户无需每版重下
