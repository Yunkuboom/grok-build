# Grok Build Desktop — 已确认实施方案

日期：2026-09-10。状态：方案已确认，进入实施与验收。

## 已确认决定

- 交付 macOS Tauri 2 桌面 App，不提供独立浏览器产品。
- 仅接入 Grok 官方服务和官方模型目录。
- 共用 `~/.grok` 登录、原生会话和配置。
- 新会话默认使用 ACP `plan` mode；恢复会话以后端返回的实际 mode 为准。

## 目标与依据

Tauri 2 薄壳 + React/TypeScript/Vite 本地 WebUI，复用本机 Grok Build agent。项目文件全部位于本目录。

- 本机 `grok` 为 1.0.24，指向原生 macOS aarch64 二进制。
- 本机帮助确认 `agent stdio`、流式 JSON、resume/fork、权限模式、MCP、插件、memory、worktree 和更新命令入口存在。
- `grok update --check --json` 可检查版本；`--version` 可指定版本。版本回退可用性仍需实测。
- 界面参考 openclaude 桌面项目的组件结构。浅色 chrome #F6F5F5、canvas #FFFFFF、accent #3A83F7，6px 内嵌间距、12px 工作区圆角、260px 侧栏；深浅及系统主题。
- 知识库不可用时不回退到另一套本地索引。

## 架构

React WebUI → Tauri IPC → Rust ACP 客户端/进程管理 → 本机 `grok agent stdio`。

生产版使用打包静态资源，无需常驻 Node 服务。CLI 仍拥有推理、工具执行、会话及压缩逻辑。Rust 仅处理协议、生命周期、配置、凭据和桌面集成。先验证 ACP initialize/auth/session/update/permission/cancel/load 的实际能力；不可将 CLI 命令存在等同于全部 ACP 能力可用。

浏览器独立使用若纳入首版，增加仅 loopback 监听、带认证及 Origin 校验的本地服务适配层，共用业务接口。

## 可视化范围

1. 项目与会话：目录选择、新建/恢复/搜索会话、置顶、应用内隐藏、原生会话 ID 对接；不把界面隐藏实现成删除 CLI 会话。
2. 对话：流式 Markdown、代码块、工具卡片、执行进度、权限批准/拒绝、取消及异常恢复。用量/子代理等仅展示真实可取得的事件。
3. 工作区：可收起侧栏、底部 PTY 终端、右侧文件/产出物预览与 diff，HTML 隔离预览。
4. 设置：登录状态、浏览器登录/API Key、自定义服务商、Base URL、协议、模型、推理强度、连接测试、权限、CLI 路径及更新、主题、诊断。
5. 扩展设置：MCP、Skills/插件、Hooks、记忆及 Worktree；先列出真实生效配置和状态，再按已验证能力提供编辑/启停。

密钥推荐使用 macOS Keychain，由后端注入 CLI 进程环境；不保存于前端 localStorage 或普通日志。配置采用保留未知项的 TOML 编辑、冲突检测及原子写入。共享原 CLI 配置还是应用隔离配置，待用户选择。

## 更新和长会话

- 更新页：当前版本、检查更新、稳定/测试渠道、手动安装、指定版本和错误日志。默认只检查，空闲时安装；共享内核更新会影响终端中的 grok，需界面明确说明。
- CLI 自带自动更新需按实际版本验证并在应用子进程中禁用，避免绕过应用更新流程。更新后做版本及 ACP 握手检查；保留恢复路径，不能先承诺任意版本可回退。
- 桌面应用自身更新是独立机制，后续如需公开分发再配置签名、发布源及 Tauri updater。
- 虚拟化长列表、批量刷新流式事件、输出缓冲上限、历史分页、监听器释放及进程清理。分别测 WebView/Rust/CLI 内存，不能仅凭使用 Tauri 承诺长会话不增长。

## 实施与验收

用户确认后，由 Sol（gpt-5.6-sol，low）实施，Astra 负责架构和最终审查。

1. 验证协议与配置边界，形成真实能力矩阵。
2. 完成真实会话、授权、模型设置及更新检查的最小闭环。
3. 扩展终端、文件、插件等可视化，完成长会话优化。
4. 构建本机 macOS app/DMG，Astra 审查代码、配置安全、会话恢复、取消、更新失败和长输出行为。

验收：实际模型调用、工具执行及批准/拒绝有效；重启恢复同一会话；设置确实传入 CLI；更新页检查真实版本；异常有可操作提示；长输出不无限增长 DOM/缓冲；无假按钮；可独立从 Finder 启动。

## 已完成确认

- macOS 桌面 App；仅 Grok 官方；共享 `~/.grok`；默认 Plan。

## 官方资料

- https://docs.x.ai/build/cli/headless-scripting
- https://docs.x.ai/build/settings/reference
- https://v2.tauri.app/concept/process-model/

官方文档与本机帮助已有部分参数差异，实现以当前 CLI 的能力探测和实测为准。
