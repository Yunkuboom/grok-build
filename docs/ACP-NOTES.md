# ACP 协议实测笔记

本文记录 Grok Build 后端与本机 Grok CLI（v1.0.25）之间 ACP 协议的**实测行为**。结论来自 `src-tauri/src/commands.rs` 的实际实现与 `scripts/` 下两个探针脚本，与 ACP 公开文档不一致处以本文为准。

## 连接与进程模型

ACP = NDJSON JSON-RPC 2.0 over stdio：每条消息一行 JSON，`\n` 分隔。后端 spawn 方式（commands.rs:161-186）：

```
grok [--permission-mode plan] agent --no-leader [--model M] [--reasoning-effort E] stdio
```

- stdin/stdout/stderr 全部 piped；env 带 `GROK_DISABLE_AUTOUPDATER=1`（commands.rs:182），防止 CLI 自动更新绕过应用更新流程。
- `--permission-mode plan` 仅在新会话时加（`default_plan = !is_resume`，commands.rs:599-600）；恢复会话时不加，以后端返回的实际 mode 为准。
- 单 agent 进程由 `AppState.agent` 持有；cwd/model/effort/plan 标志任一变化才重启进程（commands.rs:602-612），否则复用。
- 三个 tokio 任务：写 stdin（mpsc 通道，commands.rs:191-202）、读 stdout 派发行（commands.rs:211-249）、读 stderr 过滤后转发 `core-log` 事件（commands.rs:250-259）。

## 握手与消息流

1. `initialize`，params `{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{...}}`（commands.rs:273）。result 存为 `agent.capabilities`。
2. `session/new` 或 `session/load`，params `{"cwd":..., "mcpServers":[]}`，load 时额外带 `sessionId`（commands.rs:615-624）。
3. `session/prompt`，params `{"sessionId":..., "prompt":[{"type":"text","text":...}]}`（commands.rs:689）。异步：回包通过 `acp-event` 的 `prompt_complete`/`prompt_error` 推送（commands.rs:697-715）。
4. `session/cancel` 是**通知**（无 id，commands.rs:724-727）。
5. 所有 RPC 请求经 `rpc()` 助手发出，90s 超时（commands.rs:147-159）。

行派发规则（commands.rs:213-246）：有 `id` 且无 `method` → 按 id 匹配 pending 回包；有 `id` 且有 `method` → agent→client 请求，emit `acp-event {kind:"request"}`；无 `id` 有 `method` → 通知，emit `acp-event {kind:"notification"}`；非 JSON 行 → `kind:"protocol_error"`；stdout 关闭 → `kind:"closed"`。

## 实测坑 1：session/load 的 result 不含 sessionId

实测 `session/load` 的 result keys 只有 `models`、`configOptions`、`_meta` 等，**没有 `sessionId`**。修法在 commands.rs:651-657：

```rust
// session/load 的 result 不含 sessionId（实测），恢复时回退用请求里的 id
let sid = result.get("sessionId").and_then(Value::as_str)
    .map(str::to_string)
    .or_else(|| params_session_id.clone())
    .ok_or("ACP 未返回 sessionId")?;
```

并且在 commands.rs:662-663 把 `sessionId` 插回返回给前端的对象。**漏掉这一步的后果**：前端拿到的 result 没有 sessionId，恢复会话后再发消息会错误地走 `session/new` 开新会话，历史全部丢失。

## 实测坑 2：session/load 在响应到达之前回放历史

`session/load` 发出后、其 JSON-RPC response 到达**之前**，agent 会先把该会话的历史以一串 `session/update` 通知推送过来（`user_message_chunk` / `agent_thought_chunk` / `agent_message_chunk` / `tool_call` / `tool_call_update`）。响应之后还可能有少量尾随通知。

后端做法（commands.rs:625-646）：发出 load 前把 `replay.collecting` 置 true、清空缓冲；读循环里把 collecting 期间收到的 `session/update` 的 `params.update` 按到达顺序追加进 `Replay.updates`（commands.rs:229-239，同时兼容 `_x.ai/session/update` 方法名）；响应返回后停止收集，交给 `build_history()`（commands.rs:519-585）聚合：

- 连续同角色（user/assistant/thought）文本块合并成一条；
- `tool_call` 记 `{role:"tool", toolTitle, status}`，`tool_call_update` 按 `toolCallId` 回填 status/title。

聚合结果作为 `history` 字段随 `start_session` 返回，同时所有回放通知也会原样再 emit 一遍给前端（前端按通知流渲染亦可，但会重复，以前端实际消费逻辑为准）。

## 实测坑 3：session/set_config_option 的参数形态

正确参数是**纯字符串 value**：

```json
{"sessionId": "...", "configId": "model", "value": "grok-4"}
```

把 value 包成对象（`{"value": {"value": "..."}}`）会被拒绝：untagged enum mismatch。探针 `acp_probe_load.py:92-100` 验证过三种形态。

- 合法 configId 来自 start_session result 的 `configOptions`：实测 id 为 `model`、`reasoning_effort`；category 为 `model`、`thought_level`。
- 后端 `set_session_option`（commands.rs:758-792）允许前端传 id 或 category，category 会在缓存的 configOptions 里自动映射成 id。
- 返回更新后的 `{"configOptions": [...]}`。

**切 mode 不要用 set_config_option，也不要用 `session/set_mode`**（对权限档无效，见坑 4 修正）。权限模式切换由后端 `set_session_mode` 命令以「重启 agent + session/load 恢复」实现。

## 实测坑 4：session/new 无 modes 字段

实测 `session/new` 的 result keys = `sessionId`、`models`、`configOptions`、`_meta`——**`modes` 为 null**。后果与对策：

- **权限模式列表不能从 ACP 拿**（`modes.availableModes` 不存在，`modes.currentModeId` 同理）。前端改用 CLI 原生六模式硬编码列表（src/types.ts:170-182 的 `PERMISSION_MODES`），依据 `~/.grok/docs/user-guide/22-permissions-and-safety.md:35-42`：
  - `plan`（计划；官方定位为兼容模式）、`default`（询问，官方默认）、`acceptEdits`（接受编辑）、`auto`（自动）、`dontAsk`（不询问）、`bypassPermissions`（始终批准，产品名 **always-approve**）。
  - **切换不能再走 `session/set_mode`**：实测该 RPC 对任何 modeId（dontAsk/plan/agent…）都返回 `{}` 但**不改变权限行为**——它只切 plan/agent 代理配置，权限六档它不管。权限模式只能在 spawn 时用 `--permission-mode <mode>`（全局 flag，放 agent 子命令前）决定：实测 bypassPermissions spawn 的会话写文件零询问直接成功，plan spawn 的会话执行前必问。后端 `set_session_mode` 命令（commands.rs）因此实现为「杀 agent → 新 mode spawn → session/load 恢复」，不要再回头用 RPC。
- `configOptions` 里实测有两个 select：`model` 与 `reasoning_effort`（category 分别为 `model`、`thought_level`）；`reasoning_effort` 的选项为 `low` / `medium` / `high` / `xhigh`。前端 types.ts 的 `EFFORT_FALLBACK` 只列了 low/medium/high 三档兜底，真实选项以 ACP 返回为准（`normalizeConfigOptions` 归一化后渲染）。

注意与坑 1 的对照：`session/load` 的 result 是 `models`/`configOptions`/`_meta`（无 sessionId 也无 modes），`session/new` 多了 sessionId 但同样没有 modes——**modes 在两条路径上都拿不到**。

## 实测坑 5：availableCommands 在 `_meta` 里

`initialize` 的 result 顶层只有 `protocolVersion`、`agentCapabilities`、`authMethods`、`_meta`——斜杠命令列表**不在顶层**，实测在 `result._meta.availableCommands`。

- 后端读取处 commands.rs:287-291：先试顶层 `availableCommands`，`.or_else` 回退读 `_meta.availableCommands`；随后注入 `start_session` 返回给前端的对象（commands.rs:700），前端类型见 types.ts:64-68。
- 元素结构：`{name, description, input: {hint}}`（`input` 可为 null）。
- 实测本机 v1.0.25 共 **7 个**斜杠命令：`compact` / `always-approve` / `context` / `session-info` / `deep-research` / `workflow` / `goal`。
- 用法：没有专门的 RPC，客户端把 `/name args` 作为**普通 prompt 文本**发 `session/prompt` 即可。

教训同坑 4：**ACP 元数据的位置以探针实测为准**，不要按公开 schema 假设层级。

## `_x.ai/ask_user_question`（抉择请求）

agent 需要用户抉择时发来 JSON-RPC **request** `method: "_x.ai/ask_user_question"`，实测结论（探针 scripts/acp_probe_ask.py ~ ask4.py，均跑过真实会话）：

- **触发**：params = `{sessionId, toolCallId, questions:[{question, options:[{label, description}], multiSelect}], mode}`。到来前有预告通知：`session/update` 的 `sessionUpdate=="pending_interaction"`、`kind=="question"`。
- **回包**（serde 逐字段试错实测确认）：
  - 接受：result = `{"outcome":"accepted","answers":{"<问题原文>":"<选中label>" | ["label",…]（多选） | "<自定义文本>"（填空）}}`
  - 取消：`{"outcome":"skip_interview"}`；另有合法变体 `"chat_about_this"`（前端未接）。
  - **answers 是以问题原文为 key 的 map**；顶层必须有 `outcome` 字段（内部 tag），缺了整包被拒。
- **坑：请求 id 可能是 0**，与客户端自增 id 空间独立；读循环靠**有无 `method` 字段**区分 request/response（commands.rs:225-246 的派发现有逻辑天然兼容，勿改成按 id 范围判断）。
- **后端转发**：与其他 agent→client 请求共用 `acp-event` 的 `{kind:"request", method, requestId, params}` 通道，前端按 method 分流到抉择卡（src/components/AskUserCard.tsx，支持单选/多选/自定义填空/markdown 预览）。回包命令为 `ask_reply(requestId, outcome, answers?)`（commands.rs:790-809）——契约细节见 IPC.md `ask_reply` 一节，**改这里必须同步 IPC.md**。
- **超时**：grok 有 `[toolset.ask_user_question]` 超时配置（docs/user-guide/05-configuration.md:213-215，默认 1800s，`timeout_enabled=false` 可关）；超时不答 agent 会自行继续。前端已在 turn 结束/取消时清卡防挂死。

## `_x.ai/exit_plan_mode`（计划批准）

plan 模式下 agent 完成规划要进入执行时发来 JSON-RPC **request** `method: "_x.ai/exit_plan_mode"`，params `{"sessionId", "toolCallId", "planContent": "<完整 markdown 计划>"}`（实测，多轮探针确认）。

- **后果警告**：不回包 agent **永久挂起**（用户实测卡死转圈停不下来）——前端必须接这个请求并回包。
- **回包**（JSON-RPC result，回显请求 id）：
  - 批准 = `{"outcome":"approved"}`——**实证通过**：回包后 agent 立即继续执行并真实创建了文件。
  - 继续规划/取消 = `{}`（空对象）——**实证**：agent 回到规划状态继续与用户讨论。注意 `{}` 不是错误响应，语义就是"不批准、继续规划"。
  - 要求修改 = `{"outcome":"request_changes","feedback":"<文本>"}`——**按形态推断，未实测**。
- **后端转发**：读循环对带 id+method 的行统一 emit `acp-event {kind:"request", method, requestId, params}`，exit_plan_mode 天然已被转发，无需后端改动；回包命令 `exit_plan_reply(requestId, outcome, feedback?)`（commands.rs，与 permission_reply 同一 writer 通道）。

## agent→client 请求：session/request_permission

agent 发起带 id 的请求时（典型为 `session/request_permission`），前端弹权限批准卡，用户选择后调用 `permission_reply(requestId, optionId)`，后端按 id 回一条 JSON-RPC response（commands.rs:741-757）：

- 批准：`{"jsonrpc":"2.0","id":requestId,"result":{"outcome":{"outcome":"selected","optionId":"..."}}}`
- 取消：`{"outcome":{"outcome":"cancelled"}}`（optionId 为 null）

不回 response 会让 agent 一直挂起等待。

## client→agent：_x.ai/session/rename（改名）

`{"sessionId": "<id>", "title": "<新名>"}` → 成功返回 `{"success": true}`；title 空白报 `-32600 "title must not be blank"`。**initialize 之后直接发即可改任意会话，无需 session/load 或 session/new**（实测改名后 `grok sessions list` 立即反映，持久化到 CLI 会话存储）。后端命令 `rename_session(cwd, sessionId, title)`（commands.rs，无活动 agent 时按 config spawn 一个常驻复用）。

## superpowers（SP）per-session 加载

- 安装位置 `~/.grok/installed-plugins/<repo_key>`，**repo_key 不要硬编码**（当前是 superpowers-21e2a56d）：运行时用 `grok plugin list --json` 找 `name=="superpowers"` 的 `path` 字段（后端进程级缓存，commands.rs `superpowers_dir()`）。
- **flag 位置教训**：`--plugin-dir` 是 `agent` 子命令的 flag，必须放子命令后——`grok [--permission-mode X] [--rules Y] agent --no-leader --plugin-dir <DIR> stdio`；放全局位置报 `unexpected argument`（踩过）。与全局 flag（--permission-mode/--rules）的位置恰好相反，改 spawn 参数时注意。
- debug 日志实证带上后 `plugin discovered name=superpowers scope=cli has_hooks=true`。
- 官方依据 `~/.grok/docs/user-guide/09-plugins.md` 加载作用域表：`--plugin-dir` 为进程级（该 agent 进程内有效、自动信任、可重复）；另有 `_meta.pluginDirs`（session/new / session/load 参数）的会话级等价物，本项目未用。
- 开关命令 `set_sp_enabled(enabled)`：持久化 config.spEnabled + 复用 `respawn_keep_session` 换 flag 重启（回放抑制同 set_session_mode）。

## client→agent：_x.ai/session/fork（分叉会话）

params `{"sourceSessionId": "<id>", "sourceCwd": "<cwd>", "newCwd": "<cwd>"}`，与 rename 一样 **initialize 后即可用，无需 load**。实测成功返回：

```json
{"newSessionId":"…","chatMessagesCopied":12,"updatesCopied":34,"planStateCopied":false,"newCwd":"…","parentSessionId":"…"}
```

源会话已被删时报 internal error。后端命令 `fork_session(cwd, sessionId)`，返回值原样透传给前端。

## per-turn 用量在 prompt 响应的 `_meta` 里

`session/prompt` 的 result 顶层 `_meta` 含该 turn 的 `totalTokens` / `inputTokens` / `outputTokens`——前端每条消息的 token 显示用这里（经 `acp-event` 的 `prompt_complete` 的 result 取 `_meta`）。会话级累计用量仍用 `grok usage <id>` / `workspace_usage`。

## session/update 事件种类与字段

通知 params 形如 `{"sessionId":..., "update":{...}}`，`update.sessionUpdate` 区分种类：

| sessionUpdate | 字段 | 说明 |
|---|---|---|
| `user_message_chunk` | `content.text` | 用户消息回放 |
| `agent_message_chunk` | `content.text` | 助手正文流式片段（App.tsx:225-236 追加合并） |
| `agent_thought_chunk` | `content.text` | 思考流式片段 |
| `tool_call` | `toolCallId`, `title`, `status`, `content` | 新工具调用卡片（App.tsx:250-258） |
| `tool_call_update` | `toolCallId`, `status?`, `title?`, `content?` | 更新既有卡片（App.tsx:259-289） |
| `current_mode_update` | `currentModeId`（兼容 `modeId`） | mode 变化（App.tsx:290-291） |
| `plan` | `entries:[{content, priority, status}]` | 计划进度卡（App.tsx:307-334） |
| `pending_interaction` | `kind`（如 `"question"`）、`tool_call_id` | 抉择请求预告（见上节） |
| `turn_end` 等其他 | — | 后端原样转发，前端目前不消费 |

status 实测值含 `in_progress` / `completed` 等。

## session/prompt 附件内容块（实测）

`session/prompt` 的 `prompt` 数组除 text 块外支持三类附件块（后端 `send_prompt` 的 `attachments` 参数，commands.rs `build_attachment_block`）：

- **`{"type":"image","data":<base64>,"mimeType":"image/png"}`**：initialize 的 `promptCapabilities.image` 官方能力位是 **false，但实测发送后能到模型**；注意极小图会被系统丢弃并附系统提示告知模型（正常尺寸可用）。
- **`{"type":"resource","resource":{"uri":"file://…","text":"…","mimeType":"…"}}`**：`promptCapabilities.embeddedContext: true`，文本附件内嵌上下文用这块。
- **`{"type":"resource_link","uri","name","mimeType"}`**：链接形态，二进制/超大文件的兜底。

教训同坑 4/5：**promptCapabilities 的 false 不代表功能不可用**，以真实探针为准。

## 探针脚本

只读探针（除注明外都不发 prompt），用于 CLI 升级后回归验证协议行为：

- `scripts/acp_probe.py [cwd]`：spawn `grok agent --no-leader stdio` → initialize → session/new，打印 result；若 availableModes 含 plan 则再试 `session/set_mode`。验证握手、新会话返回结构（sessionId、models、configOptions、modes）。
- `scripts/acp_probe_load.py <cwd> <session_id>`：initialize → `session/load` 一个既有会话，统计响应前/后回放的通知条数与种类（验证坑 2），打印 result keys（验证坑 1），再连发三种形态的 `session/set_config_option` + 一次 `session/set_mode`（验证坑 3）。
- `scripts/acp_probe_ask4.py '<json 回包>' [期望回显文本]`：`_x.ai/ask_user_question` 回包形态的**参数化回归工具**（会跑真实会话触发抉择请求，把 argv[1] 的 JSON 原样作为 result 回包，打印 serde 报错与 agent 是否回显所选答案）。**协议回归用这个**；`acp_probe_ask.py` / `ask2.py` / `ask3.py` 是当时的试错过程稿，可读但不必维护。

跑法：

```bash
python3 scripts/acp_probe.py /path/to/project
python3 scripts/acp_probe_load.py /path/to/project <session-uuid>
python3 scripts/acp_probe_ask4.py '{"outcome":"accepted"}'
```
