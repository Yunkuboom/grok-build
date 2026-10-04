# Tauri macOS 踩坑指南

Tauri 2.11.5 + macOS 上踩过的坑与最终方案。改窗口、打包、权限配置前必读。

## 窗口拖拽：三层机制，绝不能破坏

配置是 `titleBarStyle: "Overlay"` + `hiddenTitle: true`（tauri.conf.json:21-22），保留原生红绿灯（`trafficLightPosition` 14/18）。在此配置下**拖拽默认失效**，根因：

Tauri 注入的 drag.js 处理 `[data-tauri-drag-region]` 的 mousedown 时调 `plugin:window|start_dragging`，而 `core:window:default` **不含** `allow-start-dragging` 权限，调用被 ACL 静默拒绝——不报错、不拖拽。

修复需要三层同时存在，缺一即坏：

1. **capabilities 权限**：`src-tauri/capabilities/default.json` 里的 `"core:window:allow-start-dragging"`。**这行不能删。**
2. **前端全局 mousedown 兜底**：App.tsx:169-182（代码里标了"必须保留"注释）。排除交互元素（`button, input, textarea, select, a, label, [role="button"]`）后，对 `[data-tauri-drag-region]` 内左键按下调 `getCurrentWindow().startDragging()`。
3. **CSS app-region**：styles.css:2700-2719——`[data-tauri-drag-region] { -webkit-app-region: drag; }`，交互元素 `no-drag`。原生兜底，前两层都失效时仍可用。

同时 **不要** 开 `decorations: false` 或 `transparent: true`：保留原生窗口 chrome 作为兜底，无 chrome 窗口出问题后连红绿灯都没有。主题切换走 `setTheme`，需要 capabilities 里的 `core:window:allow-set-theme`。

## 图标

- `bundle.icon` 数组**必须显式写进 tauri.conf.json**（当前 tauri.conf.json:43-49）。缺省时打出过没有 `Resources/icon.icns` 的残包——构建不报错，但 .app 是通用图标甚至启动异常。
- 全套图标用 `npx tauri icon <源png>` 生成到 `src-tauri/icons/`。
- 源图是 webp 时先转 png：`sips -s format png in.webp --out out.png`（`tauri icon` 不认 webp）。

## DMG 打包失败排查

`npm run tauri build` 里 `bundle_dmg.sh` 失败（常见报错为资源忙/无法附加），九成是系统残留的挂载卷：

```bash
hdiutil info | grep -i "Grok Build"   # 找 rw.*.dmg 和 /Volumes/dmg.* 残留
hdiutil detach -force /Volumes/dmg.XXXX # 清掉
```

清理后重跑即可。实在不行手动出包：

```bash
# staging 目录里放 Grok Build.app 和指向 /Applications 的软链
hdiutil create -volname "Grok Build" -srcfolder staging -ov -format UDZO "Grok Build_0.1.0_aarch64.dmg"
```

构建产物位置：`src-tauri/target/release/bundle/macos/Grok Build.app` 与 `src-tauri/target/release/bundle/dmg/Grok Build_<ver>_aarch64.dmg`。

## CSP

CSP 在 tauri.conf.json:30：

```
default-src 'self'; img-src 'self' asset: data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost
```

- `img-src` 必须带 `'self'`（前端打包的 png 资源，如 src/assets/grok-logo.png）和 `data:`（内联图）；少了会白图。
- `style-src 'unsafe-inline'` 是 React/Vite 内联样式所需。
- 前端只有 Tauri IPC，无 HTTP 服务，connect-src 保持最小。

## 锁屏 + 远程桌面 = 黑屏假象（不是代码问题）

症状：App 窗口全黑，AX 树里看不到 webview 内容，但 WebContent 进程活着、日志里 `markLayersVolatile` 死循环重试。**根因在系统，不在代码**：macOS 控制台处于锁屏态（`lsappinfo front` 显示 `loginwindow`）且正被 UU远程/类似远程桌面工具连接时，WindowServer 不向 webview 投递可见性，webview 永不绘制首帧。

排查顺序（照此来，别先怀疑代码死循环）：

```bash
lsappinfo front          # 看是不是 loginwindow 持有前台
pmset -g assertions      # 看有没有远程桌面工具持有的 assertion
```

确认后解锁本机屏幕或断开远程会话即恢复。

## 前端诊断通道（release 可用）

`src/main.tsx:7-17` 保留全局错误钩子：`window.onerror` / `unhandledrejection` → `invoke('frontend_log')` → 后端 `frontend_log` 命令（lib.rs:100-106）追加写 `/tmp/grok-builder-frontend.log`（每条截 900 字符，ERR/REJ 前缀）。查前端诡异问题（白屏、黑屏、按钮无反应）先读这个文件，再开 devtools。
