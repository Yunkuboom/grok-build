# AGENTS.md — Grok Build Desktop

> 本文件是后续接手的 AI agent / 开发者的入口文档。先读这里，再按需要读 IPC.md 与 docs/。

## 这是什么

本机 Grok CLI（grok build，v1.0.25）的 macOS 桌面 GUI。Tauri 2.11.5 + React 18 + TypeScript + Vite 6，Rust 后端经 ACP 协议（NDJSON JSON-RPC over stdio）对接 `grok agent stdio`，与 CLI 共用 `~/.grok` 登录、会话与配置。

**当前状态**：v0.1.0 可用。`.app` 与 DMG 已构建并实际验证（拖拽、发消息、会话恢复均工作），产物在 `src-tauri/target/release/bundle/`（`macos/Grok Build.app`、`dmg/Grok Build_0.1.0_aarch64.dmg`）。

## 目录结构速览

```
src/                        React 前端
  App.tsx                   主组件：状态、acp-event 分发、窗口拖拽兜底
  main.tsx                  入口；无 Tauri 且 /m 路径挂手机壳
  bridge.ts                 invoke/listen：桌面走 Tauri，手机走 WebSocket
  mobile/                   手机 PWA 壳（会话列表 + 聊天 + 权限/抉择）
  types.ts                  前后端共享 TS 类型 + configOptions 规范化
  styles.css                全部样式（含 data-tauri-drag-region 规则）
  icons.tsx                 lucide-react 再导出
  components/
    Sidebar.tsx             左侧栏：目录选择、会话列表/搜索/新建/恢复/删除/导出
    HomeHero.tsx            无会话时的首页
    ChatPanel.tsx           消息流渲染（react-markdown + remark-gfm）
    ToolCard.tsx            单个工具调用卡片（权限内嵌）
    Composer.tsx            输入框：发送/取消、mode/model/effort 切换
    TerminalPanel.tsx       底部 xterm.js PTY 终端
    FilesDiffPanel.tsx      右 dock：文件树/预览/diff
    GitPanel.tsx            右 dock：git 状态/stage/commit/分支
    ArtifactsPanel.tsx      右 dock：产出物
    UsageModal.tsx          用量弹窗（costUsdTicks ÷ 1e10 换算 USD）
    SettingsModal.tsx       8 分区设置（818 行，最大的组件）
src-tauri/src/
  commands.rs               全部 CLI 子进程 + ACP 客户端（spawn 注入 --rules 与 GROK_MEMORY）
  companion.rs              局域网 HTTP+WS 网关；令牌在 ~/.grok-builder/companion.json
  git_files.rs              文件树 + git 面板命令（shell 出系统 git，8s 超时）
  pty.rs                    portable-pty 终端会话
  config.rs                 应用配置持久化（~/.grok-builder/config.json）
  memory.rs                 记忆文件管理 + ADHD/Memo 规则组合 + memo-kb 冷库检索
  lib.rs                    Tauri Builder：插件、state、全部 invoke_handler 注册
scripts/
  acp_probe.py              ACP 握手 + session/new + set_mode 探针（只读）
  acp_probe_load.py         session/load 回放 + set_config_option 形态探针（只读）
  acp_probe_ask4.py         ask_user_question 回包参数化回归工具（ask~ask3 是过程稿，不维护）
IPC.md                      IPC 契约：全部 command/事件的参数与返回结构
docs/
  ACP-NOTES.md              ACP 协议实测笔记（三个实测坑 + modes 缺失，改 ACP 代码前必读）
  GROK-CLI.md               grok CLI 子命令能力矩阵、--rules 与跨会话记忆
  TAURI-MACOS.md            Tauri macOS 踩坑（拖拽/图标/DMG/CSP/锁屏远程黑屏/前端日志通道）
PLAN.md / ACCEPTANCE.md     Codex 时代的历史文档，不维护，别当真
```

## 常用命令

```bash
npm install                 # 装依赖
npm run build               # tsc + vite build，前端改动后的检查
npm run tauri dev           # 开发模式（热更新 + Rust 后端）
bash scripts/macos-release.sh
                            # Apple Silicon 发布包：路径重映射、手机页面进 Resources、
                            # 资源放齐后 ad hoc 签名，再出 DMG。不是 Developer ID，未公证。
cd src-tauri && cargo build # 仅编后端（改 rs 后的快速检查）
```

## 修改铁律

1. **IPC 一律以 IPC.md 为准。** 改了 `commands.rs`/`git_files.rs`/`pty.rs`/`config.rs` 里任何 command 的签名、返回结构或事件，必须同步更新 IPC.md。前端 invoke 的参数名是 camelCase（Rust snake_case 自动转换）。
2. **窗口拖拽三层机制绝不能破坏**（详见 docs/TAURI-MACOS.md）：capabilities 里的 `core:window:allow-start-dragging` 不能删；App.tsx:169-182 的 mousedown 兜底不能删；styles.css 的 `[data-tauri-drag-region]` 规则不能删。也不要开 `decorations:false`/`transparent`。
3. **密钥与安全**：
   - 不要在前端 localStorage 存任何密钥/token；凭据归 CLI 的 `~/.grok` 管。
   - 子进程 stderr 必须过滤含 `auth.json`/`token` 的行。commands.rs 的 `exec`/`output`/`run_cmd` 助手（commands.rs:83-145）已内置过滤与 ANSI 剥离——**新 CLI 命令必须走这些助手**，不要自己裸 `Command`。
   - ACP agent 的 stderr 过滤在 commands.rs:250-259，模式相同。
4. **CLI 参数不确定就先跑 `<bin> <cmd> --help` 实证**，不要凭记忆或官方文档猜（文档与本机版本已有出入）。二进制解析顺序见 commands.rs 的 `grok_path()`（commands.rs:52-81）：`~/.grok/bin/grok` → `~/.local/bin/grok` → 登录 shell `which` 兜底。所有子进程必须带 `GROK_DISABLE_AUTOUPDATER=1`。
5. ACP 行为以 docs/ACP-NOTES.md 的实测结论为准；CLI 升级后用 `scripts/` 两个探针回归验证再改代码。
6. 应用内"隐藏会话"只能做前端过滤，不能实现成删除 CLI 会话。
7. **三个注入开关**（`adhdAlwaysOn` / `autoMemory` / `memoKbEnabled`，默认 true/true/false，config.rs:22-27）改变的是 **spawn 时**的 `--rules` 组合与 `GROK_MEMORY` env（commands.rs:177-190），对已在跑的 agent 无影响，**改动后需重启 agent 才生效**。Agent restart 比较键已含 `rules_key` 与 `auto_memory`（commands.rs:625-626），下一次 `start_session` 会自动按新开关重启；但不要做成"热切换当前会话"的假象。
8. **身份规则来自用户文件，不写进仓库。** `compose_rules` 只在 `~/.grok-builder/identity-rules.md` 存在且非空时把它放在第一段，不随 ADHD/Memo 开关。`autoMemory` 开启时，用标记 `<!-- grok-build-identity -->` 判断全局 `~/.grok/memory/MEMORY.md` 是否已播种，**只做一次**；没有该文件就不写。不要把个人称呼或私人服务地址硬编码回源码。
9. **ACP 元数据位置以探针实测为准**，不要按公开 schema 假设层级——先例：availableCommands 实测在 `initialize` result 的 `_meta` 里而不在顶层（commands.rs:287-291 的 `.or_else` 回退）。新增对 initialize/session 结果字段的任何依赖前，先跑 `scripts/` 两个探针验证字段真实位置再写代码。

## 验证清单

- 改完后端：`cd src-tauri && cargo build`，**0 warning**。
- 改完前端：`npm run build`，**0 错误**（tsc 会先跑）。
- 改了 commands.rs 任何 command/事件：核对 IPC.md 已同步。
- 大改（ACP 流程、窗口配置、打包配置）：`npm run tauri build`，然后**实际启动 .app 测一次**：窗口拖拽、新建会话发消息、恢复旧会话发消息（验证 sessionId 回填，见 ACP-NOTES.md 坑 1）。
