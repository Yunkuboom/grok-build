# Grok Build Desktop

本机 [Grok CLI](https://docs.x.ai/build/cli)（grok build）的 macOS 桌面 GUI。Tauri 2 + React 18 + TypeScript + Vite 6，经 ACP 协议（NDJSON JSON-RPC over stdio）对接 `grok agent stdio`，与 CLI 共用 `~/.grok` 的登录、会话和配置——终端里的 grok 和本应用看到的是同一批会话。

## 功能

- **侧栏会话管理**：选择项目目录，新建/恢复/搜索/删除会话，导出会话为 Markdown。
- **流式 Markdown 聊天**：助手正文与思考过程分条流式渲染（react-markdown + GFM），工具调用以卡片展示进度与结果。
- **权限批准卡**：agent 请求工具权限时弹出批准/拒绝卡片（ACP `session/request_permission`）；新会话默认 plan 权限模式，可随时切换 mode/模型/推理强度。
- **grok 原生六档权限模式**：plan（计划）/default（询问，官方默认）/acceptEdits（接受编辑）/auto（自动）/dontAsk（不询问）/bypassPermissions（始终批准，产品名 always-approve），随切随生效。
- **记忆与偏好**：三个独立开关——ADHD 简洁注入（i-have-adhd 规则块进系统提示）、热 MEMORY（grok 跨会话记忆，`GROK_MEMORY` 控制）、Memo 冷库（memo-kb 只读检索规则注入）。
- **「记住这条」一键记忆**：把当前要点追加进 `~/.grok/memory/` 的 MEMORY.md（自动匹配工作区文件，否则落全局）。
- **`/` 斜杠命令菜单**：grok 原生 7 命令（compact/always-approve/context/session-info/deep-research/workflow/goal），列表来自 ACP `availableCommands`，选中后作为普通 prompt 发送。
- **`@` 工作区文件补全**：输入 `@` 弹出当前工作区文件菜单，快速把文件路径带进 prompt。
- **忙时消息队列**：生成中输入框为空时按钮用于停止；输入后同一按钮切换为排队发送。排队消息支持改变方向立即插入、撤回编辑、删除，以及拖拽或方向键排序。
- **会话置顶/隐藏**：侧栏会话可置顶或隐藏，状态只存应用 config（`pinnedSessions`/`hiddenSessions`），不动 CLI 会话本体。
- **计划（plan）进度卡**：收到 ACP plan 更新时渲染三态 checklist（待办/进行中/已完成，含优先级）。
- **结构化抉择卡**：agent 需要抉择时（`_x.ai/ask_user_question`）弹选项卡——单选/多选/自定义填空/markdown 预览；取消即回 `skip_interview`，超时未答 agent 会自行继续。
- **设置页记忆管理**：直接查看/编辑全局与各工作区 MEMORY.md，Memo 冷库可用性探测与试搜。
- **xterm PTY 终端**：底部可收起的真终端（登录 shell，xterm.js + portable-pty）。
- **右侧三 dock**：文件树/预览/diff、Git 面板（status/stage/commit/分支切换）、产出物。
- **用量弹窗**：单会话与工作区聚合用量，cost 换算自 `costUsdTicks`（1e10 ticks = 1 USD）。
- **8 分区设置**：CLI 状态与登录（OAuth/设备码，经 Terminal.app）、更新检查与渠道切换、MCP 服务器管理、插件、memory、worktree、外观主题等。
- 深浅色 + 跟随系统主题；配置存于 `~/.grok-builder/config.json`。
- **手机联动**：设置 → 手机联动，打开后扫码。手机 PWA 与桌面共用同一个 agent、同一批 `~/.grok` 会话和项目文件夹。电脑端需保持运行。

## 构建与运行

```bash
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 产出：
                       #   src-tauri/target/release/bundle/macos/Grok Build.app
                       #   src-tauri/target/release/bundle/dmg/Grok Build_0.1.0_aarch64.dmg
```

前提：已安装并登录 Grok CLI（`~/.grok/bin/grok` 或 `~/.local/bin/grok`，开发基线为 v1.0.25）。未登录时在应用内点登录，会在 Terminal.app 里完成官方 OAuth/设备码认证。应用不内置 API Key。

## 用户自己的配置

这些文件留在本机，不要提交进仓库：

- `~/.grok-builder/config.json`：应用设置，首次保存时生成。
- `~/.grok-builder/identity-rules.md`：可选。文件存在且非空时，内容会注入 agent 的 `--rules`；开启自动记忆后，还会用标记 `<!-- grok-build-identity -->` 播种到 `~/.grok/memory/MEMORY.md` 一次。示例见 [docs/identity-rules.example.md](docs/identity-rules.example.md)。
- `~/.grok-builder/memo-retrieval.py`：可选。未安装 `memo-kb` 时的只读检索回退脚本。
- `~/.grok-builder/companion.json`：手机配对令牌，打开手机联动时在本机生成，权限 `0600`。
- 环境变量 `GROK_BIN`：仅在 `grok` 不在默认查找路径时使用。见 [.env.example](.env.example)。

手机页面由桌面进程在 `8788` 端口提供，不单独发布客户端密钥。配对令牌只出现在本机二维码和手机浏览器里。

## 文档索引

- [AGENTS.md](AGENTS.md) — **接手开发入口**：目录结构、命令、修改铁律、验证清单。
- [IPC.md](IPC.md) — 前后端 IPC 契约（全部 command 与事件，唯一事实来源）。
- [docs/ACP-NOTES.md](docs/ACP-NOTES.md) — ACP 协议实测笔记（session/load 三个实测坑 + session/new 无 modes 字段）。
- [docs/GROK-CLI.md](docs/GROK-CLI.md) — grok CLI 子命令能力矩阵、--rules 注入与跨会话记忆。
- [docs/TAURI-MACOS.md](docs/TAURI-MACOS.md) — Tauri macOS 踩坑指南（窗口拖拽/图标/DMG/CSP）。
- PLAN.md / ACCEPTANCE.md — 早期设计/验收文档，仅存档参考。

## 致谢

UI 设计语言参考了 openclaude 桌面项目：浅色 chrome、工作区圆角、侧栏布局与 git 面板的 Rust 实现思路均源自该项目。该项目的许可证只覆盖被复制的部分，不覆盖本仓库整体。本仓库自身的许可证尚未选定。
