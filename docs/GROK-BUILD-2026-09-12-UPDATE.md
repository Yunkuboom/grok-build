# Grok Build 2026-09-12 更新与技术说明

## 更新结论

本次更新将手机联动调整为“长期可信连接”模式：手机完成一次配对后，普通网络中断、Wi-Fi/蜂窝切换以及 Grok Build 重启均不要求重新扫码。只有用户主动关闭联动或更换令牌时，旧连接才被撤销。

该模型优先满足个人使用场景中的远程便利性，同时把安全边界放在长期随机凭据、显式撤销和已登记工作区上，不采用每次连接确认或短时 token。

## 手机联动架构

```text
Phone PWA
  └─ HTTP 页面 + WebSocket JSON-RPC
       └─ Companion gateway（0.0.0.0:8788）
            ├─ 长随机 bearer token
            ├─ connection generation 撤销机制
            ├─ registered workspace 校验
            └─ Tauri AppState / Grok ACP agent
```

- 手机是控制面，不运行 Grok CLI，也不复制项目运行时。
- Companion 与桌面端共用同一个 `AppState.agent` 和 ACP 事件流。
- 凭据存于电脑 `~/.grok-builder/companion.json`，Unix 权限为 `0600`。
- 手机浏览器持久保存配对凭据以支持长期恢复；首次消费二维码后会从地址栏移除 token。
- 已启用状态、端口和原 token 会在应用启动时恢复。

## 生命周期语义

| 场景 | 行为 |
| --- | --- |
| 手机暂时断网、切换网络 | 指数退避自动重连，原凭据继续有效 |
| Grok Build 正常重启 | 自动恢复 Companion listener，复用原端口和 token |
| 点击“关闭联动” | listener 停止、token 清空、连接 generation 变化，旧连接在 1 秒内关闭 |
| 点击“更换令牌” | listener 不重启，端口不变；生成新 token，旧连接在 1 秒内关闭 |
| token 错误或已撤销 | WebSocket 建连拒绝或现有连接关闭 |

## 工作区边界

手机端可以访问：

- `config.lastCwd`
- `config.recentCwds[]`
- 当前桌面活动会话的工作目录

所有路径先 canonicalize，再做精确工作区匹配。远程客户端不能通过自行传入 `/`、用户主目录或其它未登记路径来浏览磁盘或启动 Agent。新增工作区仍由桌面端完成一次登记；登记后手机可长期使用，无需逐次确认。

## 本次修复

1. 新增应用启动自动恢复手机联动。
2. 普通重新启用不自动轮换有效的持久 token。
3. 新增 connection generation，确保主动关闭/换码真正撤销已连接 WebSocket。
4. 所有带 `cwd` 的手机 RPC 增加已登记工作区校验。
5. 配对成功后清除地址栏中的 `#t=...`。
6. 修复生产 PWA manifest 引用不存在的 `/src/assets/...` 图标；增加 192px 与 512px 图标。
7. 设置持久化失败不再静默忽略，界面会显示错误。
8. `bridge.isTauri()` 改为检查真实 invoke 能力，减少环境误判。
9. 桌面端与手机端的忙时输入合并为单按钮：空输入停止，有文本时排队，入队后自动恢复停止状态。
10. 排队卡片新增“改变方向”立即插入、撤回编辑、删除、六点把手拖拽排序，并支持键盘上下键排序。
11. “改变方向”增加 prompt epoch 防竞态：已取消旧轮的迟到回包不会清除新轮 busy 状态，也不会发出错误的完成/失败事件。

## 排队交互语义

| 操作 | 行为 |
| --- | --- |
| 运行中、输入为空 | 单一主按钮显示为停止 |
| 运行中、输入有内容 | 同一按钮显示排队发送；点击后清空输入并恢复停止 |
| 改变方向 | 从队列移除目标消息，取消当前轮，保留其它队列消息并立即发送目标消息 |
| 重新编辑 | 从队列撤回消息到输入框并自动聚焦，不中断当前轮 |
| 删除 | 仅移除目标排队消息 |
| 排序 | 鼠标/触控拖拽六点把手；键盘聚焦把手后使用上下方向键 |

## 回归测试与构建

- `cargo test`：3 项通过。
  - token 必须为固定长度十六进制随机值。
  - connection generation 变化后旧连接认证失败。
  - 未登记路径不能伪装成远程工作区。
- `npm run build`：通过。
- `npm run tauri -- build --bundles app`：通过，release 二进制和 macOS `.app` 已生成。
- PWA 图标已验证进入 `dist/icons/`，manifest 生产路径正确。
- 本轮 macOS 应用包：`src-tauri/target/release/bundle/macos/Grok Build.app`。
- DMG 收尾因 macOS 上存在多个同名已挂载 Grok Build 卷而失败；属于本机打包环境问题，不是源码编译错误。

## 远程网络建议

- 同一局域网可直接使用二维码中的 HTTP 地址。
- 出门访问建议使用 Tailscale；或者在 Companion 前放置带 TLS 的可信隧道。
- 不应把 8788 明文端口直接映射到公网。
- token 等同远程完整控制密码，不应转发、截图公开或写入项目仓库。

## 已知待办

- 桌面 Vite 根页面仍不是受支持的独立 Web 模式，直接打开可能触发组件中的 Tauri API 调用；正式 Tauri 应用和 `/m` 手机页面不受影响。
- 前端主 bundle 约 819 KB，可继续对 Settings、Terminal、Git/Diff 和 Usage 模块做懒加载。
- 需要逐步补充 ACP 会话恢复、权限回复和多客户端事件顺序的集成测试。
- DMG 再构建前应先由用户确认并卸载残留的同名测试卷。

## 相关文档

- `AGENTS.md`：项目入口、约束和验证清单。
- `IPC.md`：完整前后端命令与 Companion 契约。
- `docs/ACP-NOTES.md`：ACP 实测行为。
- `docs/GROK-CLI.md`：CLI 能力和参数。
- `docs/TAURI-MACOS.md`：macOS/Tauri 构建与排障经验。
- `DESIGN_SYSTEM.md`：当前视觉设计系统和移动体验原则。
