# Grok Build Desktop — IPC 契约

Tauri 2 后端（`src-tauri/src/`）暴露的全部 command 与事件。前端通过 `invoke(name, args)` 调用；参数名为 camelCase（Rust snake_case 自动转换）。所有 command 失败时 reject 一个字符串错误。

约定：
- `CmdResult` = `{ ok: boolean, output: string }`（一次性 CLI 命令的统一返回；output 已去 ANSI、stderr 已过滤含 `auth.json`/`token` 的行）。
- `Value`/`any` = 直接透传的 JSON（来自 `grok ... --json` 或 ACP 响应），结构以后端实际透传为准。
- 所有 `grok` 子进程使用解析后的绝对路径：`~/.grok/bin/grok` → `~/.local/bin/grok` → 登录 shell `$SHELL -lc 'which grok'`（解析失败报错"未找到 grok CLI…"）。子进程均带 `GROK_DISABLE_AUTOUPDATER=1`。

## 核心状态 / 会话列表

### `core_status() -> CoreStatus`
```ts
{
  cliPath: string; version: string; authenticated: boolean; authMessage: string;
  models: Array<{ id: string; name: string; isDefault: boolean }>;
  inspect: any;   // grok inspect --json 的解析结果（失败为 null）
}
```

### `list_sessions(cwd: string) -> Array<SessionEntry>`
### `search_sessions(cwd: string, query: string) -> Array<SessionEntry>`
query 为空时退化为 `list_sessions`。
```ts
type SessionEntry = { id: string; title: string; updated?: string | null };
```
`title` 只取列表行的 SUMMARY 列（行格式 `<id>  <CREATED>  <UPDATED>  <STATUS>  <SUMMARY>`，2+ 空格分列）；`updated` 取 UPDATED 列（如 "2026-09-10"），取不到为 null。`search_sessions` 不保证有 `updated`。

### `delete_session(sessionId: string) -> CmdResult`
`grok sessions delete <id>`（无 -y 标志，后端向 stdin 喂 `y` 以防交互确认）。

### `rename_session(cwd: string, sessionId: string, title: string) -> CmdResult`
改名走 ACP `_x.ai/session/rename`（**无需 session/load 或 session/new**，initialize 后直接发即可改任意会话；持久化到 CLI 会话存储，`grok sessions list` 立即反映）。有活动 agent 直接复用；没有则按当前 config（permissionMode/model/effort/规则注入）spawn 一个并留作常驻复用。title trim 后为空报错「标题不能为空」；RPC 错误不 reject，返回 `CmdResult{ok:false, output:"重命名失败：…"}`，成功 `output:"已重命名为 <title>"`。

实测协议样例：
```json
→ {"jsonrpc":"2.0","id":7,"method":"_x.ai/session/rename","params":{"sessionId":"01a0…","title":"新名字"}}
← {"jsonrpc":"2.0","id":7,"result":{"success":true}}
// title 为空：error -32600 "title must not be blank"
```

### `fork_session(cwd: string, sessionId: string) -> object`
分叉会话，走 ACP `_x.ai/session/fork`，params `{"sourceSessionId": id, "sourceCwd": cwd, "newCwd": cwd}`（与 rename 同模式：initialize 后即可用，无需 load；无活动 agent 时按 config spawn 常驻复用）。实测成功返回原样透传：
```json
{"newSessionId":"…","chatMessagesCopied":12,"updatesCopied":34,"planStateCopied":false,"newCwd":"…","parentSessionId":"…"}
```
源会话已被删时 RPC 报 internal error（前端展示错误即可）。

### `export_trace(sessionId: string) -> CmdResult`
`grok trace <id> --local --json`（60s）：本地导出 tar.gz 到 `$GROK_HOME/trace-exports/<id>.tar.gz`，output（JSON 文本）里带输出路径。

### `doctor() -> CmdResult`
`grok doctor`（60s）：终端/剪贴板/颜色支持等环境检查，原始文本。

### `disk_usage() -> object`
`grok du --json`（30s）解析后的 JSON：`{schema_version, grok_home, total_bytes, volume_capacity_bytes, volume_available_bytes, top_level_dirs:[…]}`。

### `export_session(sessionId: string) -> string`
`grok export <id>` 输出到 stdout 的 Markdown 全文（60s 超时）。

### `session_usage(sessionId: string) -> string`
`grok usage <id>` 原始输出（**未解析的 JSON 文本**，30s 超时）。单会话明细；要聚合视图用 `workspace_usage`。

### `workspace_usage(cwd: string) -> WorkspaceUsage`
先 `grok sessions list -n 50`，再对每个会话顺序跑 `grok usage <id>` 聚合（单条失败跳过；空工作区返回全零结构，不报错）。与 `session_usage` 的区别：本命令返回**解析并求和后的结构化数据**。
```ts
interface UsageStats {
  inputTokens: number; outputTokens: number; cachedReadTokens: number;
  cacheCreationTokens: number; reasoningTokens: number; totalTokens: number;
  modelCalls: number; costUsdTicks: number; turnCount: number;   // modelUsage 分解里无 turnCount，恒为 0
}
interface WorkspaceUsage {
  sessionCount: number;                  // 成功统计到的会话数
  totals: UsageStats;                    // 全部会话求和
  models: Record<string, UsageStats>;    // 按 modelId 求和（来自每个会话 usage JSON 的 session.modelUsage）
  topSessions: Array<{                   // 按 totalTokens 降序，最多 10 条
    sessionId: string; title: string | null;
    totalTokens: number; costUsdTicks: number; modelCalls: number; turnCount: number;
  }>;
}
```
`costUsdTicks` 原样传递：1e10 ticks = 1 USD，由前端换算。

## ACP 会话

### `start_session(cwd: string, sessionId: string | null, model: string, effort: string, permissionMode: string, restoreCode?: boolean | null) -> object`
- `sessionId` 为空 → ACP `session/new`；非空 → ACP `session/load`。新会话与 resume 都用 `permissionMode` spawn。
- `restoreCode`：仅 resume 有效——为 true 时 session/load params 带 `"restoreCode": true`（实测 load 接受该字段，恢复代码上下文）；新会话忽略。
- `permissionMode`：六档 CLI 值 `plan / default / acceptEdits / auto / dontAsk / bypassPermissions`（空串按 `plan` 处理）。**权限模式只能 spawn 时经 `--permission-mode` 决定**（set_mode RPC 对权限档无效，实测），因此它参与 agent 缓存 restart 比较键——变化即重启 agent。
- 返回 ACP result 对象，并额外注入：
  - `grokBuilderMode: "plan" | "restored"`
  - `currentModeId: string` — 当前 spawn 实际使用的权限模式（顶层，与 sessionId 同级）
  - `availableCommands: Array<{ name: string; description: string; input?: { hint: string } }>` — 来自 ACP `initialize` result（实测 7 个：compact/always-approve/context/session-info/deep-research/workflow/goal）。缓存在 Agent 上，agent 复用不重启时同样注入；initialize 未返回时为空数组 `[]`。
  - `history: Array<HistoryMessage>` — 恢复会话时由 session/load 回放的 `session/update` 通知聚合而成（新会话为空数组）：
    ```ts
    type HistoryMessage = {
      role: "user" | "assistant" | "thought" | "tool";
      text: string;                 // tool 角色为 ""
      toolTitle?: string;           // role === "tool"
      status?: string;              // role === "tool"（in_progress/completed/...）
    };
    ```
    连续同角色文本块已合并。`session/load` 的 result 本身不含 `sessionId`（实测），后端会回填请求的 id。
- result 里的 `configOptions`（实测 id 为 `model`、`reasoning_effort`，category 为 `model`、`thought_level`）被后端缓存，供 `set_session_option` 做 category→id 解析。

### `send_prompt(text: string, attachments?: Attachment[] | null) -> { ok: boolean; skipped: string[] }`
异步发送 ACP `session/prompt`；结果通过 `acp-event` 的 `prompt_complete`/`prompt_error` 推送。返回 `{ok:true, skipped:[…]}`（无附件时 `skipped` 为空数组）。

附件分类规则（拼在 text 块**之前**，逐个容错，单个失败/超限不阻塞其它附件，原因进 `skipped`）：
```ts
type Attachment = { path: string; name: string; mimeType: string };
```
- `mimeType` 以 `image/` 开头 → base64 `image` 块 `{"type":"image","data","mimeType"}`；>10MB 跳过并注明（协议实测：image 官方能力位 false 但实际可用，极小图会被系统丢弃并提示模型）。
- 其它类型且可读为 UTF-8 文本且 ≤512KB → embeddedContext `resource` 块 `{"type":"resource","resource":{"uri":"file://<绝对路径>","text","mimeType"}}`。
- 其余（二进制 / 超大文本）→ `resource_link` 块 `{"type":"resource_link","uri","name","mimeType"}` 兜底。
- 文件不存在/读失败 → 该附件进 `skipped`（"附件 X 读取失败：…"），不报错中断。

### `cancel_session() -> void`
发送 ACP `session/cancel` 通知。

### `stop_agent() -> void`
杀掉 ACP agent 子进程。

### `permission_reply(requestId: number, optionId: string | null) -> void`
回应 ACP `session/request_permission`；`optionId` 为 null 表示取消。

### `ask_reply(requestId: number, outcome: string, answers?: object | null) -> void`
回应 `_x.ai/ask_user_question`（结构化用户抉择请求，与 permission 共用 `acp-event` 的 `kind:"request"` 通道，前端按 `method` 分流）。
- `outcome="accepted"` → 回包 `{"outcome":"accepted","answers":answers ?? {}}`
- 其它（如 `"skip_interview"` 取消）→ 回包 `{"outcome":outcome}`（忽略 answers）

实测请求样例（agent→client，JSON-RPC request，id 实测为 0，回包必须回显同一 id）：
```json
{"jsonrpc":"2.0","id":0,"method":"_x.ai/ask_user_question","params":{
  "sessionId":"…","toolCallId":"call-…","mode":"default",
  "questions":[{"question":"问题文本","options":[{"label":"选项A","description":"说明"}],"multiSelect":null}]
}}
```
到来前会有 `session/update` 通知预告：`update.sessionUpdate=="pending_interaction"` 且 `kind=="question"`（带 `tool_call_id`）。

实测回包样例（answers 以**问题原文**为 key；value 为选中 label 字符串、多选为 string 数组、填空题为自定义文本字符串）：
```json
{"jsonrpc":"2.0","id":0,"result":{"outcome":"accepted","answers":{"问题文本":"选项A"}}}
{"jsonrpc":"2.0","id":0,"result":{"outcome":"accepted","answers":{"多选问题":["选项A","选项B"]}}}
{"jsonrpc":"2.0","id":0,"result":{"outcome":"skip_interview"}}
```

### `exit_plan_reply(requestId: number, outcome: string, feedback?: string | null) -> void`
回应 `_x.ai/exit_plan_mode`（plan 模式下 agent 退出规划、请求批准计划）。**必须回包，否则 agent 永久挂起**（实测用户卡死转圈）。同样经 `acp-event` 的 `kind:"request"` 通道到来（method == `_x.ai/exit_plan_mode`）。
- `outcome="approved"` → `{"outcome":"approved"}`（实测批准后 agent 立即继续执行）
- `outcome="request_changes"` → `{"outcome":"request_changes","feedback": feedback ?? ""}`（推断形态，未实测）
- 其它 → `{}`（空对象 = 继续规划/取消，实测 agent 回到规划状态）

实测请求样例：
```json
{"jsonrpc":"2.0","id":1,"method":"_x.ai/exit_plan_mode","params":{
  "sessionId":"…","toolCallId":"call-…","planContent":"<完整 markdown 计划>"
}}
```

### `set_session_option(configId: string, value: string) -> object`
ACP `session/set_config_option`。实测协议参数为 `{ sessionId, configId, value: "<纯字符串>" }`（**不是** `{value:{value}}`）。`configId` 可传 option id（`model` / `reasoning_effort`）或 category（`model` / `thought_level`，后端自动映射为 id）。返回更新后的 `{ configOptions: [...] }`。

### `set_session_mode(modeId: string) -> object`
**真正的权限模式切换**：`session/set_mode` RPC 对权限档无效（实测对任何 modeId 都返回 `{}` 但不改权限行为），所以后端改为——杀当前 agent → 用新 `--permission-mode <modeId>` spawn → `session/load` 恢复原 sessionId（回放的历史通知收集后丢弃，读循环在此期间不向前端 emit session/update，不会刷出重复消息）。无会话（agent 在但 sessionId 空）时只 respawn；无 agent 时报错。
- 返回 `{"currentModeId": modeId, "sessionId": string | null}`。
- modeId 与当前相同则直接返回，不重启。

### `set_sp_enabled(enabled: boolean) -> { spEnabled: boolean; restarted: boolean }`
superpowers per-session 开关。先持久化到 config（`spEnabled`）；若有活动 agent，复用与 set_session_mode 相同的「杀 agent → 新参数 spawn → session/load 恢复（回放抑制）」机制换 `--plugin-dir` 重启（内部共用 `respawn_keep_session`）；无 agent 只持久化。`restarted` 表示是否实际重启了 agent（值未变/无 agent 时为 false）。

## 更新 / 登录

### `check_update() -> any`
`grok update --check --json` 的解析结果（非 JSON 时 reject 原始文本）。

### `install_update(version?: string | null) -> string`
`grok update [--version V]`（120s 超时）；会先杀掉运行中的 agent。指定版本号即"安装特定版本"，无单独命令。

### `switch_update_channel(channel: "alpha" | "stable") -> string`
`grok update --alpha | --stable`（120s 超时）；会先杀掉运行中的 agent。

### `launch_login() -> void`
打开 macOS Terminal 跑 `grok login --oauth`。

### `launch_device_login() -> void`
打开 macOS Terminal 跑 `grok login --device-auth`。

### `logout() -> CmdResult`
直接以子进程跑 `grok logout`，并杀掉运行中的 agent。

## 文件（旧轻量版，保留）

### `list_files(root: string) -> Array<{ path: string; size: number }>`
深度 ≤4、≤500 条、跳过 dot 目录/node_modules/target、单文件 ≤2MB。

### `read_file(root: string, path: string) -> string`
防路径逃逸、≤2MB、拒绝二进制。

### `open_in_finder(path: string) -> void`
macOS `open -R <path>`：在访达中显示并选中该文件/目录。路径不存在报错「路径不存在」。（`open` 用 `/usr/bin/open` 绝对路径直跑，与 grok CLI 无关。）

### `extension_status(cwd: string) -> any`
`grok inspect --json`（在 cwd 下）的解析结果。

## PTY 终端（替代已删除的 terminal_start/write/stop）

### `pty_create(cwd?: string | null, cols?: number | null, rows?: number | null) -> { id: string }`
以登录 shell（`$SHELL -l`，默认 zsh）开 PTY；默认 120x30。输出走 `pty-output` 事件，退出走 `pty-exit`。

### `pty_write(id: string, data: string) -> void`
### `pty_resize(id: string, cols: number, rows: number) -> void`
### `pty_kill(id: string) -> void`

## Git 面板 / 文件树（`git_files.rs`，shell 出系统 git，8s 超时）

### `git_status(cwd: string) -> GitStatusResult`
```ts
{
  isRepo: boolean; branch: string;
  entries: Array<{
    path: string;            // 相对 cwd；rename 取新路径
    indexStatus: string; workTreeStatus: string;   // porcelain XY 单字符
    staged: boolean; unstaged: boolean; untracked: boolean;  // untracked 同时计入 unstaged
  }>;                        // 上限 500 条
  error?: string; warning?: string;   // 非仓库时 isRepo=false + error
}
```

### `git_diff_file(cwd: string, path: string, staged?: boolean | null) -> DiffResult`
`staged=true` → `git diff --cached`；`false` → 工作区 diff；`null/省略` → 相对 HEAD 的综合 diff（未跟踪文件合成"新增"diff）。
```ts
type DiffResult = { ok: boolean; text: string; message: string };
```

### `git_stage(cwd: string, paths: string[]) -> void`
### `git_unstage(cwd: string, paths: string[]) -> void`
### `git_commit(cwd: string, message: string) -> string`
无暂存变更时报错。
### `git_branches(cwd: string) -> { current: string; branches: string[]; error?: string }`
### `git_checkout(cwd: string, branch: string) -> void`
优先 `git switch`，回退 `git checkout`。

### `list_workdir_tree(cwd: string) -> TreeNode[]`
跳过 `.git`/`node_modules`/`target`/`dist` 等重目录与 dot 目录；深度 ≤6、≤2000 条。
```ts
type TreeNode = { name: string; path: string; relative: string; isDir: boolean; children?: TreeNode[] };
```

### `read_workdir_file(cwd: string, path: string) -> string`
防路径逃逸（含 `..` 拒绝 + canonicalize 前缀校验）、≤2MB、NUL 字节检测拒绝二进制。

## MCP 管理

### `mcp_list() -> any`
`grok mcp list --json` 解析结果（数组）。
### `mcp_add(name: string, commandOrUrl?: string | null, args?: string[] | null, transport?: "stdio"|"http"|"sse" | null, scope?: "user"|"project" | null, env?: string[] | null, headers?: string[] | null) -> CmdResult`
映射 `grok mcp add [-t transport] [-s scope] [-e K=V]... [-H "N: V"]... <name> [commandOrUrl] [-- args...]`。transport/scope 传非法值报错。
### `mcp_remove(name: string) -> CmdResult`
### `mcp_enable(name: string) -> CmdResult`
### `mcp_disable(name: string) -> CmdResult`
### `mcp_doctor() -> CmdResult`（60s 超时）

## 插件

### `plugin_list() -> any`
`grok plugin list --json` 解析结果（数组），**后端为每项补 `enabled: boolean` 字段**：CLI 输出只有 `status:"installed"` 没有启停状态；真实启停在 `~/.grok/config.toml` 的 `[plugins]` 段 `disabled = [...]` 数组（`grok plugin enable/disable` 改的就是它）。后端逐行解析该段（只认 [plugins] 内的 disabled 键，数组可跨行），name 在 disabled 里则 `enabled:false`，无该段/该行则全部 true。**前端不要再把 status 当启用状态显示。**
### `plugin_install(source: string) -> CmdResult`
`grok plugin install --trust <source>`（--trust 用于跳过交互确认；120s 超时）。
### `plugin_uninstall(name: string) -> CmdResult`
### `plugin_enable(name: string) -> CmdResult`
### `plugin_disable(name: string) -> CmdResult`

## Memory / Worktree

### `memory_clear(scope?: "workspace" | "global" | "all" | null, cwd?: string | null) -> CmdResult`
`grok memory clear --workspace|--global|--all --yes`（始终带 --yes；默认 workspace；cwd 决定 workspace 作用域，省略用当前目录）。

### `worktree_list() -> any`
`grok worktree list --json` 解析结果。
### `worktree_rm(id: string) -> CmdResult`
stdin 喂 `y` 以防交互确认。
### `worktree_gc(maxAge?: string | null) -> CmdResult`
如 `"7d"`；不传时 grok 不过期任何 worktree（相当于 dry 报告）。
### `worktree_show(id: string) -> CmdResult`
`grok worktree show <id>`，单个 worktree 详情。
### `worktree_detach(id: string) -> CmdResult`
`grok worktree detach <id>`（60s），Grove 投影 worktree 转普通 git worktree。
### `worktree_salvage(id: string, out: string) -> CmdResult`
`grok worktree salvage --out <out> <id>`（60s）。**--help 实测：`--out` 与 id 均必填**（源仓库丢失时抢救文件）。
### `worktree_clean_artifacts(id: string) -> CmdResult`
`grok worktree clean-artifacts --yes <id>`（60s）。**--help 实测：必须 `--yes` 才真正删除（不可逆）**，需 id 参数。
### `worktree_db(command?: "rebuild" | "stats" | "path" | null) -> CmdResult`
`grok worktree db <sub>`（60s）。**--help 实测：db 必须带子命令**，默认 `stats`（只读），非法值按 stats 处理。

## 插件市场源

### `marketplace_list() -> any`
`grok plugin marketplace list --json` 解析结果（数组，含源与其插件）。
### `marketplace_add(source: string) -> CmdResult`
`grok plugin marketplace add <source>`（60s；git URL / GitHub shorthand / 本地路径）。
### `marketplace_remove(source: string) -> CmdResult`
**会卸载该源的全部插件**；无 --yes 标志，stdin 喂 `y` 防交互确认。
### `marketplace_update() -> CmdResult`
`grok plugin marketplace update`（120s，刷新源并同步 git 缓存）。

## 应用配置（`config.rs`，持久化于 `~/.grok-builder/config.json`）

### `get_app_config() -> AppConfig`
### `save_app_config(config: AppConfig) -> AppConfig`
```ts
type AppConfig = {
  theme: string;            // 默认 "system"
  lastCwd: string;
  recentCwds: string[];
  model: string;
  effort: string;
  permissionMode: string;   // 默认 "plan"
  adhdAlwaysOn: boolean;    // 默认 true；spawn agent 时注入 i-have-adhd 规则块
  autoMemory: boolean;      // 默认 true；spawn 时 GROK_MEMORY=1，否则 =0（优先级高于 CLI config.toml）
  memoKbEnabled: boolean;   // 默认 false；spawn 时注入 Memo 冷库检索规则块
  pinnedSessions: string[]; // 默认 []；前端置顶的会话 id
  hiddenSessions: string[]; // 默认 []；前端隐藏的会话 id（仅过滤展示，不删 CLI 会话）
  collapsedWorkspaces: string[]; // 默认 []；侧栏折叠的工作区路径
  spEnabled: boolean;       // 默认 false；spawn agent 时按 session 加载 superpowers 插件（--plugin-dir）
};
```
读取不存在的配置返回默认值（不落盘）；保存为整体覆盖写。旧 config.json 缺这三个字段时自动用默认值。

**start_session 的 spawn 注入**（由 config 驱动，三个字段任一变化都会触发 agent 重启）：
- `--rules <composed>`（全局 flag，位于 `agent` 子命令之前）：按序拼接——a) 用户身份规则（`~/.grok-builder/identity-rules.md` 存在且非空才注入，仓库不附带个人规则）；b) ADHD 块（`adhdAlwaysOn`，依次读 `~/.openclaude-desktop/skills/i-have-adhd/SKILL.md` → `~/.agents/skills/i-have-adhd/SKILL.md` → 内嵌兜底）；c) Memo 冷库规则块（`memoKbEnabled`）。块间两个换行。缺省时 a) 整段省略。
- env `GROK_MEMORY=1|0`（`autoMemory`）。
- `spEnabled` 为 true 时按 session 加载 superpowers：路径由 `grok plugin list --json` 找 `name=="superpowers"` 的 `path` 字段解析（进程级缓存，**不硬编码 repo_key**），加在 agent 子命令后——`grok [--permission-mode X] [--rules Y] agent --no-leader --plugin-dir <DIR> [--model M] [--reasoning-effort E] stdio`。未安装/解析失败时不加 flag，并往 `core-log` 发一行「superpowers 未安装（或 plugin list 未找到 path），SP 开关无效」。
- `autoMemory` 开启、且身份规则文件非空、且全局 `~/.grok/memory/MEMORY.md` 不含 `<!-- grok-build-identity -->` 时，把该文件播种到 `## Preferences` 下，只一次。没有身份规则文件则不写记忆。

## 记忆文件 / Memo 冷库（`memory.rs`）

### `list_memory_files() -> MemoryFile[]`
全局 `~/.grok/memory/MEMORY.md`（始终列出，不存在则 `exists:false`）+ 扫描 `~/.grok/memory/*/MEMORY.md`。
```ts
type MemoryFile = { path: string; scope: "global" | "workspace"; label: string; exists: boolean; size: number };
// 全局 label="全局记忆"；工作区 label=目录名（<project-slug>-<hash8>）
```

### `read_memory_file(path: string) -> string`
仅限 `~/.grok/memory/` 内（`..` 与越界路径报错）；文件不存在返回空串。

### `write_memory_file(path: string, content: string) -> MemoryFile`
同样限 `~/.grok/memory/` 内；自动建父目录；原子写（临时文件 + rename）。返回写入后的文件信息。

### `append_memory_note(cwd: string, note: string) -> MemoryFile`
在 `~/.grok/memory/` 下按 cwd 末段 slug（小写、非字母数字转 `-`）找 `<slug>-*` 目录：唯一匹配写到该工作区 MEMORY.md，否则写全局。文件无 `## Preferences` 标题先补标题，再追加 `- {note}`。原子写。

### `open_memory_folder() -> void`
确保 `~/.grok/memory` 存在并用 macOS `open` 在访达中打开。

### `memo_kb_status() -> MemoStatus`
登录 shell `which memo-kb` → 找到则 `memo-kb search ping --json --topk 1`（15s）探测；否则检查 `~/.grok-builder/memo-retrieval.py` 存在且 `python3 <script> search ping` 可行。返回可用性与原因。
```ts
type MemoStatus = { available: boolean; detail: string };
```

### `memo_kb_search(query: string) -> CmdResult`
只读检索：优先 `memo-kb search <query> --json --topk 5`，未安装则回退 python 脚本（均 30s 超时）。`ok:false` 时 output 为原因（如「知识库暂不可用：memo-kb 未安装，回退脚本也不存在」）。

## 事件（`listen(name, cb)`）

### `acp-event`
```ts
{ kind: "request", requestId: number, method: string, params: any }        // agent→client 请求：session/request_permission（用 permission_reply 回应）、_x.ai/ask_user_question（用 ask_reply 回应）、_x.ai/exit_plan_mode（用 exit_plan_reply 回应，不回包 agent 永久挂起）
{ kind: "notification", method: string, params: any }                      // ACP 通知（session/update 等；恢复会话时的历史回放也会原样推一遍）
{ kind: "protocol_error", error: string }                                  // 非 JSON 行
{ kind: "closed" }                                                         // agent stdout 关闭
{ kind: "session_ready", sessionId: string, result: object }               // start_session 成功（result 同返回值，含 history）
{ kind: "user_echo", text: string }                                        // send_prompt 时双播用户原文，供另一端补气泡
{ kind: "prompt_complete", result: object }
{ kind: "prompt_error", error: string }
```

### `companion-state`
手机联动快照，桌面 Tauri 事件与 WebSocket 双播：
```ts
{ cwd: string; sessionId: string | null; busy: boolean; mode: string; model: string; effort: string }
```

## 手机联动（Companion PWA）

局域网 HTTP+WebSocket 网关，复用同一个 `AppState.agent`。令牌写入 `~/.grok-builder/companion.json`（0600），不进 `config.json`、不打日志。已开启的联动会在应用重启后使用原令牌自动恢复；普通断线不会要求重新配对。手机端只能访问桌面配置中已经登记的工作区。主动关闭或更换令牌会在 1 秒内撤销已有 WebSocket 连接。

### `companion_status() -> CompanionStatus`
### `companion_enable(port?: number) -> CompanionStatus`
默认端口 8788，绑定 `0.0.0.0`。返回后 `urls[]` 形如 `http://<lan-ip>:8788/m#t=<token>`。重复打开或应用重启复用持久令牌，不自动轮换。
### `companion_disable() -> CompanionStatus`
停监听并作废令牌。
### `companion_rotate_token() -> CompanionStatus`
原端口保持在线，只更换令牌并立即撤销旧连接。

```ts
type CompanionStatus = {
  enabled: boolean; port: number; token: string;
  urls: string[]; lanIps: string[]; qrSvg: string;
};
```

WebSocket：`ws://<host>:<port>/ws?t=<token>`。请求 `{id, cmd, args}`，应答 `{id, ok, result}` 或 `{id, ok:false, error}`。事件 `{event, payload}`。

白名单 command：`core_status` `get_app_config` `list_sessions` `search_sessions` `start_session` `send_prompt` `cancel_session` `permission_reply` `ask_reply` `exit_plan_reply` `set_session_option` `set_session_mode` `rename_session` `delete_session` `fork_session` `session_usage` `workspace_usage` `export_session` `list_workdir_tree` `read_workdir_file`。其它命令 403。禁止 PTY / git 写 / 登录退出 / 更新 / MCP / 插件。

### `core-log` — `string`
agent stderr 行（已去 ANSI、过滤 auth.json/token）。

### `pty-output` — `{ id: string, data: string }`
原始 PTY 输出块（含 ANSI 控制序列，供 xterm.js 消费）。

### `pty-exit` — `{ id: string, code: number }`
code 为进程退出码；kill 或异常为 -1。

## 已删除（前端勿再用）

- `terminal_start` / `terminal_write` / `terminal_stop` 及 `terminal-output` 事件 → 由 `pty_*` + `pty-output`/`pty-exit` 取代。
