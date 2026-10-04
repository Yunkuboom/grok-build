# Grok CLI 能力矩阵（v1.0.25 实测）

本文记录 GUI 实际用到的 `grok` 子命令的格式、输出与坑。CLI 行为以实测为准；**参数不确定时先跑 `<bin> <cmd> --help` 实证，不要凭文档猜**。

## 二进制解析

GUI 打包后不继承终端 shell 的 PATH，必须解析绝对路径。解析顺序（commands.rs:59-81，结果 OnceCell 缓存）：

1. `~/.grok/bin/grok`
2. `~/.local/bin/grok`
3. 登录 shell 兜底：`$SHELL -lc 'which grok'`（8s 超时）
4. 全部失败 → 报错"未找到 grok CLI…"

开发基线为 v1.0.25 stable。所有子进程统一带 env `GROK_DISABLE_AUTOUPDATER=1`（commands.rs:101、182），stderr 统一经 `filter_sensitive` 过滤含 `auth.json`/`token` 的行（commands.rs:83-88）。

## 子命令清单

| 命令 | 输出 | 注意点 |
|---|---|---|
| `grok --version` | 文本 | core_status 用（commands.rs:298） |
| `grok inspect [--json]` | JSON | extension_status / core_status 用（commands.rs:299-302、926-929） |
| `grok models` | 文本 | 无 JSON；正则解析 `Default model:` 行和 `* -` 列表行（commands.rs:306-324） |
| `grok sessions list --limit 50` | 文本 | **无 JSON**；id 正则 `[0-9a-f]{8}-[0-9a-f-]{27,}`，标题=id 行去掉 id 后的残余文本（commands.rs:339-358） |
| `grok sessions search <q> --limit 50` | 文本 | 无 JSON；**摘要行在 id 行之后**（id 行只有 score/日期），取 id 行后第一个非空行（commands.rs:381-387） |
| `grok sessions delete <id>` | 文本 | **无 -y 参数**，后端向 stdin 喂 `"y\n"` 防交互确认（commands.rs:400-403） |
| `grok export <id>` | Markdown 全文到 stdout | 60s 超时（commands.rs:407-409） |
| `grok usage <id>` | **纯 JSON** | 30s 超时；`costUsdTicks` **1e10 ticks = 1 USD**，由前端换算（官方文档 `~/.grok/docs/user-guide/17-sessions.md:288`）；`session.modelUsage` 分解里**没有 turnCount**，聚合结构里该字段恒为 0（commands.rs:472-517） |
| `grok update --check --json` | JSON | 非 JSON 输出时整个 reject（commands.rs:811-815） |
| `grok update [--version V]` | 文本 | 120s；指定版本即"安装特定版本"，无单独命令；执行前先杀 agent 进程（commands.rs:816-830） |
| `grok update --alpha \| --stable` | 文本 | 切渠道，120s；同样先杀 agent（commands.rs:831-845） |
| `grok login --oauth` / `grok login --device-auth` | 交互 | GUI 里用 osascript 让 Terminal.app 执行（commands.rs:847-873），不在应用内跑 |
| `grok logout` | 文本 | 子进程直接跑 + 杀 agent（commands.rs:875-880） |
| `grok mcp list --json` | JSON 数组 | — |
| `grok mcp add [-t transport] [-s scope] [-e K=V]... [-H "N: V"]... <name> [commandOrUrl] [-- args...]` | 文本 | transport 仅 stdio/http/sse，scope 仅 user/project（commands.rs:940-987） |
| `grok mcp remove/enable/disable <name>`、`grok mcp doctor` | 文本 | doctor 60s |
| `grok plugin list --json` | JSON | — |
| `grok plugin install --trust <source>` | 文本 | `--trust` 跳过交互确认；120s（commands.rs:1014-1021） |
| `grok plugin uninstall/enable/disable <name>` | 文本 | — |
| `grok memory clear --workspace\|--global\|--all --yes` | 文本 | 必须带 `--yes`；默认 workspace；cwd 决定 workspace 作用域（commands.rs:1037-1046） |
| `grok worktree list --json` | JSON | — |
| `grok worktree rm <id>` | 文本 | **无 -y**，stdin 喂 `"y\n"`（commands.rs:1056-1060） |
| `grok worktree gc [--max-age 7d]` | 文本 | **不传 --max-age 不会过期任何东西**（相当于 dry 报告）（commands.rs:1062-1068） |
| `grok agent --no-leader stdio` | ACP 协议 | 见 docs/ACP-NOTES.md |

登录状态检测：检查 `~/.grok/auth.json` 存在且大小 > 2 字节（commands.rs:304-305），不执行任何命令。

## 会话存储

- 会话数据：`~/.grok/sessions/<url编码的cwd>/<session-uuid>`（cwd 做百分号编码，如 `%2Fpath%2Fto%2Fexample`）。
- 搜索索引：`~/.grok/sessions/session_search.sqlite`。
- 含义：CLI 的 `sessions list` 按 cwd 分桶，所以 GUI 的会话列表依赖 cwd 参数；换目录即换会话集合。应用内"隐藏会话"只能是前端行为，不要实现成删除 CLI 会话。

## 全局 flag：`--rules`

`--rules "<文本>"` 是**全局 flag**，放在 `agent` 子命令之前：

```
grok [--permission-mode plan] --rules "<文本>" agent --no-leader stdio
```

实测 exit 0 正常握手；rules 文本会追加到系统提示。GUI 用它注入记忆/偏好规则：按序拼接用户身份规则（`~/.grok-builder/identity-rules.md` 存在且非空时）+ ADHD 块（`adhdAlwaysOn`）+ Memo 冷库规则块（`memoKbEnabled`），见 `memory.rs` 的 `compose_rules` 与 spawn 处（commands.rs:177-179）。

## 跨会话记忆（`GROK_MEMORY`）

依据 `~/.grok/docs/user-guide/13-memory.md`：

- **默认关闭**。开关优先级（13-memory.md:61）：`GROK_MEMORY` 环境变量（`1`/`true` 开、`0`/`false` 关）**高于** `~/.grok/config.toml` 的 `[memory] enabled`。GUI 在 spawn 时显式设置 `GROK_MEMORY=1|0`（commands.rs:190，由 `autoMemory` 开关决定），保证应用内行为不被用户 config.toml 影响。
- 记忆文件（13-memory.md:74-76）：
  - 全局：`~/.grok/memory/MEMORY.md`（跨项目偏好）；
  - 工作区：`~/.grok/memory/<project-slug>-<hash8>/MEMORY.md`（hash 来自仓库 origin 或目录路径；同仓库的 clone/worktree 共享一个目录）；
  - 另有 `<slug>-<hash8>/sessions/` 存每会话摘要。
- 外部直接编辑这些文件也生效：文件 watcher 会在下次记忆检索时自动重建索引（13-memory.md:159、339 的 `watcher.enabled`）。
- 实测：开启后 grok 会**自建工作区记忆文件**，文件头为 `# Project Memory — <cwd>` + `> Auto-populated by dream consolidation`（本机 `~/.grok/memory/grokbuild-e46660d2/MEMORY.md` 即如此）。所以 GUI 的 `list_memory_files` 会看到并非自己创建的目录，属正常。
- GUI 侧的查看/编辑/追加命令（`list_memory_files`/`read_memory_file`/`write_memory_file`/`append_memory_note`/`open_memory_folder`）都在 `memory.rs`，路径严格限制在 `~/.grok/memory/` 内（memory.rs:159-192）。
