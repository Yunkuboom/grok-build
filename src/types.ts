import { t } from './i18n';
export type ThemePreference = 'system' | 'light' | 'dark';

export type AppConfig = {
  theme: string;
  lastCwd: string;
  recentCwds: string[];
  model: string;
  effort: string;
  permissionMode: string;
  adhdAlwaysOn: boolean;
  autoMemory: boolean;
  memoKbEnabled: boolean;
  pinnedSessions: string[];
  hiddenSessions: string[];
  collapsedWorkspaces: string[];
  spEnabled: boolean;
  /** "system" follows the OS language. "zh" and "en" are explicit. */
  locale: 'system' | 'zh' | 'en' | string;
};

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  lastCwd: '',
  recentCwds: [],
  model: '',
  effort: '',
  permissionMode: 'plan',
  adhdAlwaysOn: true,
  autoMemory: true,
  memoKbEnabled: false,
  pinnedSessions: [],
  hiddenSessions: [],
  collapsedWorkspaces: [],
  spEnabled: false,
  locale: 'system',
};

export type ModelInfo = { id: string; name: string; isDefault: boolean };

export type CoreStatus = {
  cliPath: string;
  version: string;
  authenticated: boolean;
  authMessage: string;
  models: ModelInfo[];
  inspect: unknown;
};

export type SessionEntry = { id: string; title: string; cwd: string; updated?: string | null };

export type HistoryMessage = {
  role: 'user' | 'assistant' | 'thought' | 'tool';
  text: string;
  toolTitle?: string;
  status?: string;
};

export type PlanEntry = { content: string; priority?: string; status?: string };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'thought' | 'tool' | 'plan';
  text: string;
  toolId?: string;
  toolTitle?: string;
  toolStatus?: string;
  planEntries?: PlanEntry[];
  streaming?: boolean;
  ts?: number;
  turnTokens?: number;
};

export type AvailableCommand = {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
};

// ——— 结构化抉择卡（_x.ai/ask_user_question）———
export type AskQuestion = {
  question: string;
  options?: Array<{ label: string; description?: string }> | null;
  multiSelect?: boolean | null;
  preview?: string | null;
};

export type AskRequest = {
  requestId: number;
  sessionId: string;
  toolCallId?: string;
  mode?: string;
  questions: AskQuestion[];
};

// ——— plan 模式退出批准（_x.ai/exit_plan_mode）———
export type ExitPlanRequest = {
  requestId: number;
  sessionId: string;
  toolCallId?: string;
  planContent: string;
};

export type ExitPlanOutcome = 'approved' | 'request_changes' | 'abandoned';

export type PermissionOption = { optionId: string; name: string; kind?: string };

export type PermissionRequest = {
  requestId: number;
  sessionId: string;
  toolCall: unknown;
  options: PermissionOption[];
};

export type SessionModeInfo = { id: string; name?: string };

export type ConfigOptionValue = { value: string; label: string };

export type SessionResult = {
  sessionId: string;
  grokBuilderMode?: 'plan' | 'restored';
  currentModeId?: string;
  history?: HistoryMessage[];
  historyTs?: number;
  modes?: { currentModeId?: string; availableModes?: SessionModeInfo[] };
  configOptions?: unknown[];
  availableCommands?: AvailableCommand[];
  [key: string]: unknown;
};

export type AcpEvent = {
  kind: string;
  requestId?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  error?: string;
  result?: Record<string, unknown>;
};

export type CmdResult = { ok: boolean; output: string };

export type TreeNode = {
  name: string;
  path: string;
  relative: string;
  isDir: boolean;
  children?: TreeNode[];
};

export type DiffResult = { ok: boolean; text: string; message: string };

export type GitStatusEntry = {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

export type GitStatusResult = {
  isRepo: boolean;
  branch: string;
  entries: GitStatusEntry[];
  error?: string;
  warning?: string;
};

export type GitBranchesResult = { current: string; branches: string[]; error?: string };

// ——— Grok 用量（session_usage / workspace_usage）———
export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelCalls: number;
  costUsdTicks: number;
  turnCount: number;
};

export type SessionUsage = {
  sessionId: string;
  updatedAt?: string;
  session: UsageStats & {
    modelUsage?: Record<string, UsageStats>;
    primaryModelId?: string;
  };
  turns?: unknown[];
};

export type WorkspaceUsage = {
  sessionCount: number;
  totals: UsageStats;
  models: Record<string, UsageStats>;
  topSessions: Array<{
    sessionId: string;
    title: string | null;
    totalTokens: number;
    costUsdTicks: number;
    modelCalls: number;
    turnCount: number;
  }>;
};

// ——— 记忆（list/read/write/append_memory_file、memo KB）———
export type MemoryFile = {
  path: string;
  scope: 'global' | 'workspace';
  label: string;
  exists: boolean;
  size: number;
};

export type MemoStatus = { available: boolean; detail: string };

export type CompanionStatus = {
  enabled: boolean;
  port: number;
  token: string;
  urls: string[];
  lanIps: string[];
  qrSvg: string;
};

// ——— 附件 ———
export type Attachment = { path: string; name: string; mimeType: string };

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rs: 'text/plain',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] || 'application/octet-stream';
}

export type PermissionModeMeta = { id: string; label: string; hint: string; warn?: boolean };

export function permissionModes(): PermissionModeMeta[] {
  return [
  { id: 'plan', label: t('计划', 'Plan'), hint: t('先给出方案，经你确认后再动手（兼容模式）', 'Propose a plan and wait for your approval (compatibility mode)') },
  { id: 'default', label: t('询问', 'Ask'), hint: t('官方默认：只读操作自动放行，其余逐项请求批准', 'Official default: read-only actions run, everything else asks') },
  { id: 'acceptEdits', label: t('接受编辑', 'Accept edits'), hint: t('文件编辑不再询问，其余仍请求批准', 'File edits run without asking; other actions still ask') },
  { id: 'auto', label: t('自动', 'Auto'), hint: t('安全检查允许的直接执行，存疑的升级询问或阻止', 'Run what safety checks allow; ask or block when unsure') },
  { id: 'dontAsk', label: t('不询问', "Don't ask"), hint: t('仅放行预批准工具和只读命令（CI 严格白名单）', 'Only pre-approved tools and read-only commands (strict CI allowlist)') },
  {
    id: 'bypassPermissions',
    label: t('始终批准', 'Always approve'),
    hint: t('所有工具调用免询问；deny 规则和 hooks 仍生效，谨慎使用', 'Tools run without asking. Deny rules and hooks still apply. Use with care'),
    warn: true,
  },
  ];
}

export const EFFORT_FALLBACK: ConfigOptionValue[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;

/** 从 ACP content 块中提取纯文本 */
export const textFrom = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFrom).join('');
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  return textFrom(v.text ?? v.content ?? v.message);
};

/** configOptions 里的可选项形状不透明，做防御性归一化 */
export function normalizeConfigOptions(raw: unknown): Array<{
  id: string;
  category: string;
  currentValue: string;
  options: ConfigOptionValue[];
}> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const id = String(o.id ?? '');
      if (!id) return null;
      const rawOptions = Array.isArray(o.options) ? o.options : [];
      const options = rawOptions
        .map((opt): ConfigOptionValue | null => {
          if (typeof opt === 'string') return { value: opt, label: opt };
          if (!opt || typeof opt !== 'object') return null;
          const p = opt as Record<string, unknown>;
          const value = String(p.value ?? p.id ?? p.name ?? '');
          if (!value) return null;
          return { value, label: String(p.name ?? p.label ?? p.title ?? value) };
        })
        .filter((x): x is ConfigOptionValue => !!x);
      return {
        id,
        category: String(o.category ?? ''),
        currentValue: String(o.currentValue ?? o.value ?? ''),
        options,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}
