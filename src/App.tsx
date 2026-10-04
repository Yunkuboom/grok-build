import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import MessageNav from './components/MessageNav';
import PinnedPlan from './components/PinnedPlan';
import HomeHero from './components/HomeHero';
import Composer from './components/Composer';
import QueueList, { type QueuedMessage } from './components/QueueList';
import TerminalPanel from './components/TerminalPanel';
import FilesDiffPanel from './components/FilesDiffPanel';
import GitPanel from './components/GitPanel';
import ArtifactsPanel from './components/ArtifactsPanel';
import SettingsModal from './components/SettingsModal';
import UsageModal from './components/UsageModal';
import PermissionCard from './components/PermissionCard';
import AskUserCard from './components/AskUserCard';
import PlanExitCard from './components/PlanExitCard';
import {
  DEFAULT_CONFIG,
  EFFORT_FALLBACK,
  guessMime,
  normalizeConfigOptions,
  textFrom,
  uid,
  type AcpEvent,
  type AppConfig,
  type AskRequest,
  type Attachment,
  type AvailableCommand,
  type ChatMessage,
  type CmdResult,
  type ExitPlanOutcome,
  type ExitPlanRequest,
  type ConfigOptionValue,
  type CoreStatus,
  type MemoryFile,
  type PermissionRequest,
  type PlanEntry,
  type SessionEntry,
  type SessionModeInfo,
  type SessionResult,
  type ThemePreference,
} from './types';
import { ArrowDown, Files, FolderGit2, Loader2, PanelRight, Pencil, SquareTerminal, X, Zap } from './icons';
import InlineRename from './components/InlineRename';

type EffectiveTheme = 'light' | 'dark';
type RightDock = 'files' | 'git' | 'artifacts' | null;

const MAX_MESSAGES = 500;

function resolveEffectiveTheme(pref: ThemePreference): EffectiveTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [cwd, setCwd] = useState('');
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [sessionsByCwd, setSessionsByCwd] = useState<Record<string, SessionEntry[]>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trimmed, setTrimmed] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [mode, setMode] = useState('plan');
  const [modeBusy, setModeBusy] = useState(false);
  const [availableModes, setAvailableModes] = useState<SessionModeInfo[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [effortOptions, setEffortOptions] = useState<ConfigOptionValue[]>(EFFORT_FALLBACK);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [rememberState, setRememberState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [notice, setNotice] = useState('');
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [exitPlan, setExitPlan] = useState<ExitPlanRequest | null>(null);
  const [headerRenaming, setHeaderRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [spBusy, setSpBusy] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [rightDock, setRightDock] = useState<RightDock>(null);

  const configRef = useRef(config);
  configRef.current = config;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const noticeTimer = useRef<number | null>(null);
  const rememberTimer = useRef<number | null>(null);
  const jumpRef = useRef<(() => void) | null>(null);
  const [showJump, setShowJump] = useState(false);
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;

  const addAttachments = useCallback((paths: string[]) => {
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.path));
      const next = [...prev];
      for (const p of paths) {
        if (!p || existing.has(p)) continue;
        existing.add(p);
        next.push({
          path: p,
          name: p.split('/').filter(Boolean).at(-1) || p,
          mimeType: guessMime(p),
        });
      }
      return next;
    });
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  // 原生拖拽文件进窗口 → 附件（只接文件路径，文本拖拽忽略；非 Tauri 环境直接跳过）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === 'over' || p.type === 'enter') {
            setDragOver(true);
          } else if (p.type === 'leave') {
            setDragOver(false);
          } else if (p.type === 'drop') {
            setDragOver(false);
            if (p.paths?.length) addAttachments(p.paths);
          }
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        /* 浏览器/dev 无 Tauri webview，忽略 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addAttachments]);

  const flashNotice = useCallback((msg: string, ms = 2500) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), ms);
  }, []);

  const chatActive = !!activeSessionId || messages.length > 0;
  // 工作区树：当前 cwd 恒在第一位；折叠状态来自 config
  const workspaces = useMemo(
    () => [cwd, ...config.recentCwds.filter((p) => p && p !== cwd)].filter(Boolean),
    [cwd, config.recentCwds],
  );
  const collapsedWsSet = useMemo(
    () => new Set(config.collapsedWorkspaces),
    [config.collapsedWorkspaces],
  );
  const workspacesRef = useRef<string[]>([]);
  workspacesRef.current = workspaces;
  const collapsedWsRef = useRef<Set<string>>(new Set());
  collapsedWsRef.current = collapsedWsSet;
  const activeTitle =
    Object.values(sessionsByCwd)
      .flat()
      .find((s) => s.id === activeSessionId)?.title ?? '';
  const userMessages = useMemo(
    () =>
      messages
        .filter((m) => m.role === 'user')
        .map((m) => ({ id: m.id, text: m.text })),
    [messages],
  );

  // 最后一条 plan 消息 → 钉住的计划面板
  const pinnedPlan = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'plan') return messages[i].planEntries || null;
    }
    return null;
  }, [messages]);

  const jumpToMessage = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-flash');
    window.setTimeout(() => el.classList.remove('msg-flash'), 1000);
  }, []);

  // ——— 配置 ———
  const saveConfig = useCallback((patch: Partial<AppConfig>) => {
    const next = { ...configRef.current, ...patch };
    setConfig(next);
    invoke<AppConfig>('save_app_config', { config: next })
      .then((saved) => setConfig(saved))
      .catch((e) => setError(`设置保存失败：${String(e)}`));
  }, []);

  const applyCwd = useCallback(
    (path: string) => {
      setCwd(path);
      setActiveSessionId(null);
      setMessages([]);
      setTrimmed(false);
      setPermission(null);
      setAskRequest(null);
      setExitPlan(null);
      setAvailableModes([]);
      setAvailableCommands([]);
      setQueue([]);
      setAttachments([]);
      const recent = [path, ...configRef.current.recentCwds.filter((p) => p !== path)].slice(0, 8);
      saveConfig({ lastCwd: path, recentCwds: recent });
    },
    [saveConfig],
  );

  const refreshCore = useCallback(async () => {
    try {
      const next = await invoke<CoreStatus>('core_status');
      setStatus(next);
      setModel((current) => current || next.models.find((m) => m.isDefault)?.id || next.models[0]?.id || '');
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshSessions = useCallback(() => {
    // 刷新所有已展开的工作区；折叠的保留缓存不拉取
    for (const w of workspacesRef.current) {
      if (collapsedWsRef.current.has(w)) continue;
      invoke<SessionEntry[]>('list_sessions', { cwd: w })
        .then((list) => setSessionsByCwd((prev) => ({ ...prev, [w]: list })))
        .catch(() => setSessionsByCwd((prev) => ({ ...prev, [w]: [] })));
    }
  }, []);

  // ——— 启动：恢复配置 ———
  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<AppConfig>('get_app_config');
        const merged = { ...DEFAULT_CONFIG, ...cfg };
        setConfig(merged);
        setCwd(cfg.lastCwd || '');
        setModel(cfg.model || '');
        setEffort(cfg.effort || '');
        setMode(cfg.permissionMode || 'plan');
      } catch (e) {
        setError(String(e));
      } finally {
        setConfigLoaded(true);
      }
      await refreshCore();
    })();
  }, [refreshCore]);

  useEffect(() => {
    if (!configLoaded) return;
    refreshSessions();
  }, [configLoaded, workspaces, collapsedWsSet, refreshSessions]);

  // ——— 主题 ———
  useEffect(() => {
    const pref = (config.theme || 'system') as ThemePreference;
    const apply = () => {
      const effective = resolveEffectiveTheme(pref);
      document.documentElement.dataset.theme = effective;
      document.documentElement.style.colorScheme = effective;
      // 非 Tauri 环境（浏览器 dev）getCurrentWindow 会同步抛错，必须吞掉
      try {
        void getCurrentWindow()
          .setTheme(pref === 'system' ? null : effective)
          .catch(() => {});
      } catch {
        /* ignore */
      }
    };
    apply();
    if (pref !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [config.theme]);

  // ——— 窗口拖拽（Overlay titleBarStyle，必须保留）———
  useEffect(() => {
    const interactive = 'button, input, textarea, select, a, label, [role="button"]';
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(interactive)) return;
      if (!target.closest('[data-tauri-drag-region]')) return;
      e.preventDefault();
      try {
        void getCurrentWindow().startDragging().catch(() => {});
      } catch {
        /* 非 Tauri 环境 */
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ——— ACP 事件 ———
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen<AcpEvent>('acp-event', ({ payload }) => {
      if (payload.kind === 'closed') {
        setBusy(false);
        setAskRequest(null);
        setExitPlan(null);
        setMessages((items) => items.map((m) => ({ ...m, streaming: false })));
        return;
      }
      if (payload.kind === 'user_echo') {
        const text = String((payload as AcpEvent & { text?: string }).text || '');
        if (!text) return;
        setMessages((items) => {
          const last = items.at(-1);
          if (last?.role === 'user' && last.text === text) return items;
          return [
            ...items.map((m) => ({ ...m, streaming: false })),
            { id: uid('m'), role: 'user', text, ts: Date.now() },
          ];
        });
        return;
      }
      if (payload.kind === 'session_ready') {
        const result = payload.result as SessionResult | undefined;
        if (result?.sessionId) {
          setActiveSessionId(result.sessionId);
          const history = (result.history || []).map((h) => ({
            id: uid('m'),
            role: h.role,
            text: h.text,
            toolTitle: h.toolTitle,
            toolStatus: h.status,
            ts: result.historyTs,
          }));
          setMessages(history);
          setTrimmed(false);
          if (result.availableCommands) setAvailableCommands(result.availableCommands);
          if (result.currentModeId) setMode(result.currentModeId);
        }
        void refreshSessions();
        return;
      }
      if (payload.kind === 'prompt_complete') {
        setBusy(false);
        setAskRequest(null);
        setExitPlan(null);
        // 本轮 token：result._meta.totalTokens 记到最后一条 assistant 消息
        const meta = (payload.result?._meta ?? payload.result) as
          | Record<string, unknown>
          | undefined;
        const total = typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined;
        setMessages((items) => {
          const next = items.map((m) => ({ ...m, streaming: false }));
          if (total !== undefined && next.length) {
            let idx = -1;
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === 'assistant') {
                idx = i;
                break;
              }
            }
            if (idx < 0) idx = next.length - 1;
            next[idx] = { ...next[idx], turnTokens: total };
          }
          return next;
        });
        void refreshSessions();
        return;
      }
      if (payload.kind === 'prompt_error') {
        setBusy(false);
        setAskRequest(null);
        setExitPlan(null);
        setMessages((items) => items.map((m) => ({ ...m, streaming: false })));
        setError(payload.error || 'Grok 请求失败');
        return;
      }
      if (payload.kind === 'protocol_error') {
        setError(payload.error || 'ACP 协议错误');
        return;
      }
      if (payload.kind === 'request' && payload.method === 'session/request_permission') {
        const p = payload.params || {};
        setPermission({
          requestId: payload.requestId ?? 0,
          sessionId: String(p.sessionId || ''),
          toolCall: p.toolCall,
          options: Array.isArray(p.options) ? (p.options as PermissionRequest['options']) : [],
        });
        return;
      }
      if (payload.kind === 'request' && payload.method === '_x.ai/ask_user_question') {
        const p = payload.params || {};
        const rawQuestions = Array.isArray(p.questions) ? p.questions : [];
        const questions = rawQuestions
          .map((q): AskRequest['questions'][number] | null => {
            if (!q || typeof q !== 'object') return null;
            const o = q as Record<string, unknown>;
            const question = String(o.question ?? o.title ?? '');
            if (!question) return null;
            const rawOptions = Array.isArray(o.options) ? o.options : null;
            return {
              question,
              options: rawOptions
                ? rawOptions
                    .map((opt): { label: string; description?: string } | null => {
                      if (!opt || typeof opt !== 'object') return null;
                      const oo = opt as Record<string, unknown>;
                      const label = String(oo.label ?? oo.name ?? oo.value ?? '');
                      if (!label) return null;
                      const description = oo.description ? String(oo.description) : undefined;
                      return description === undefined ? { label } : { label, description };
                    })
                    .filter((x): x is { label: string; description?: string } => !!x)
                : null,
              multiSelect: typeof o.multiSelect === 'boolean' ? o.multiSelect : null,
              preview: typeof o.preview === 'string' && o.preview ? o.preview : null,
            };
          })
          .filter((x): x is AskRequest['questions'][number] => !!x);
        if (!questions.length) return;
        setAskRequest({
          requestId: payload.requestId ?? 0,
          sessionId: String(p.sessionId || ''),
          toolCallId: p.toolCallId ? String(p.toolCallId) : undefined,
          mode: p.mode ? String(p.mode) : undefined,
          questions,
        });
        return;
      }
      if (payload.kind === 'request' && payload.method === '_x.ai/exit_plan_mode') {
        const p = payload.params || {};
        setExitPlan({
          requestId: payload.requestId ?? 0,
          sessionId: String(p.sessionId || ''),
          toolCallId: p.toolCallId ? String(p.toolCallId) : undefined,
          planContent: String(p.planContent ?? p.plan ?? ''),
        });
        return;
      }
      if (payload.kind !== 'notification' || payload.method !== 'session/update') return;
      const params = payload.params || {};
      const update = (params.update || {}) as Record<string, unknown>;
      const kind = String(update.sessionUpdate || update.type || '');

      if (kind === 'agent_message_chunk') {
        const chunk = textFrom(update.content ?? update);
        if (!chunk) return;
        setMessages((items) => {
          const last = items.at(-1);
          if (last?.role === 'assistant' && last.streaming) {
            return [...items.slice(0, -1), { ...last, text: last.text + chunk }];
          }
          return [
            ...items.map((m) => ({ ...m, streaming: false })),
            { id: uid('m'), role: 'assistant' as const, text: chunk, streaming: true, ts: Date.now() },
          ];
        });
      } else if (kind === 'agent_thought_chunk') {
        const chunk = textFrom(update.content ?? update);
        if (!chunk) return;
        setMessages((items) => {
          const last = items.at(-1);
          if (last?.role === 'thought' && last.streaming) {
            return [...items.slice(0, -1), { ...last, text: last.text + chunk }];
          }
          return [
            ...items.map((m) => ({ ...m, streaming: false })),
            { id: uid('m'), role: 'thought' as const, text: chunk, streaming: true, ts: Date.now() },
          ];
        });
      } else if (kind === 'tool_call') {
        const toolId = String(update.toolCallId || uid('tool'));
        const title = String(update.title || update.toolCallId || '工具调用');
        const status = String(update.status || 'in_progress');
        const detail = textFrom(update.content ?? '');
        setMessages((items) => [
          ...items.map((m) => ({ ...m, streaming: false })),
          { id: uid('m'), role: 'tool' as const, text: detail, toolId, toolTitle: title, toolStatus: status, ts: Date.now() },
        ]);
      } else if (kind === 'tool_call_update') {
        const toolId = String(update.toolCallId || '');
        if (!toolId) return;
        const status = update.status ? String(update.status) : undefined;
        const title = update.title ? String(update.title) : undefined;
        const detail = textFrom(update.content ?? '');
        setMessages((items) => {
          const idx = items.findIndex((m) => m.role === 'tool' && m.toolId === toolId);
          if (idx < 0) {
            return [
              ...items,
              {
                id: uid('m'),
                role: 'tool' as const,
                text: detail,
                toolId,
                toolTitle: title || '工具调用',
                toolStatus: status || 'in_progress',
                ts: Date.now(),
              },
            ];
          }
          const next = [...items];
          const prev = next[idx];
          next[idx] = {
            ...prev,
            toolTitle: title || prev.toolTitle,
            toolStatus: status || prev.toolStatus,
            text: detail ? (prev.text ? `${prev.text}\n${detail}` : detail) : prev.text,
          };
          return next;
        });
      } else if (kind === 'plan') {
        const planObj = update.plan as Record<string, unknown> | undefined;
        const raw = planObj?.entries ?? update.entries;
        if (!Array.isArray(raw)) return;
        const entries = raw
          .map((e): PlanEntry | null => {
            if (!e || typeof e !== 'object') return null;
            const o = e as Record<string, unknown>;
            const content = String(o.content ?? o.title ?? o.text ?? '');
            if (!content) return null;
            return {
              content,
              priority: o.priority ? String(o.priority) : undefined,
              status: o.status ? String(o.status) : undefined,
            };
          })
          .filter((x): x is PlanEntry => !!x);
        if (!entries.length) return;
        setMessages((items) => {
          const lastUserIdx = items.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
          const lastPlanIdx = items.reduce((acc, m, i) => (m.role === 'plan' ? i : acc), -1);
          if (lastPlanIdx > lastUserIdx) {
            const next = [...items];
            next[lastPlanIdx] = { ...next[lastPlanIdx], planEntries: entries };
            return next;
          }
          return [...items, { id: uid('m'), role: 'plan' as const, text: '', planEntries: entries, ts: Date.now() }];
        });
      } else if (kind === 'current_mode_update') {
        setMode(String(update.currentModeId || update.modeId || 'plan'));
      }
    })
      .then((fn) => unsubs.push(fn))
      .catch(() => {});
    listen<Record<string, unknown>>('companion-state', ({ payload }) => {
      if (typeof payload?.cwd === 'string' && payload.cwd) setCwd(payload.cwd);
      if (typeof payload?.busy === 'boolean') setBusy(payload.busy);
      if (typeof payload?.mode === 'string' && payload.mode) setMode(payload.mode);
      if (typeof payload?.model === 'string' && payload.model) setModel(payload.model);
      if (typeof payload?.sessionId === 'string' && payload.sessionId) {
        setActiveSessionId(payload.sessionId);
      }
    })
      .then((fn) => unsubs.push(fn))
      .catch(() => {});
    return () => unsubs.forEach((fn) => fn());
  }, [refreshSessions]);

  // ——— 消息裁剪 ———
  useEffect(() => {
    if (messages.length > MAX_MESSAGES) {
      setMessages((items) => items.slice(-MAX_MESSAGES));
      setTrimmed(true);
    }
  }, [messages]);

  // ——— 会话操作 ———
  const start = useCallback(
    async (
      resume?: string,
      cwdOverride?: string,
      restoreCode?: boolean,
    ): Promise<SessionResult | undefined> => {
      const dir = cwdOverride || cwdRef.current;
      if (!dir) {
        setError('请先选择工作区文件夹');
        return undefined;
      }
      setBusy(true);
      setError('');
      setPermission(null);
      try {
        const result = await invoke<SessionResult>('start_session', {
          cwd: dir,
          sessionId: resume || null,
          model,
          effort,
          permissionMode: configRef.current.permissionMode || 'plan',
          restoreCode: resume && restoreCode ? true : undefined,
        });
        setActiveSessionId(result.sessionId);
        const history = (result.history || []).map((h) => ({
          id: uid('m'),
          role: h.role,
          text: h.text,
          toolTitle: h.toolTitle,
          toolStatus: h.status,
          ts: result.historyTs,
        }));
        setMessages(history);
        setTrimmed(false);
        setAvailableModes(result.modes?.availableModes || []);
        setAvailableCommands(result.availableCommands || []);
        const opts = normalizeConfigOptions(result.configOptions);
        const effortOpt = opts.find((o) => o.id === 'reasoning_effort' || o.category === 'thought_level');
        setEffortOptions(effortOpt?.options.length ? effortOpt.options : EFFORT_FALLBACK);
        const modelOpt = opts.find((o) => o.id === 'model' || o.category === 'model');
        if (modelOpt?.currentValue) setModel(modelOpt.currentValue);
        if (effortOpt?.currentValue) setEffort(effortOpt.currentValue);
        setMode(result.currentModeId || result.modes?.currentModeId || configRef.current.permissionMode || 'plan');
        void refreshSessions();
        return result;
      } catch (e) {
        setError(String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [model, effort, refreshSessions],
  );

  const newTask = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setTrimmed(false);
    setInput('');
    setError('');
    setPermission(null);
    setAskRequest(null);
    setExitPlan(null);
    setAvailableModes([]);
    setAvailableCommands([]);
    setQueue([]);
    setAttachments([]);
    setMode(configRef.current.permissionMode || 'plan');
  }, []);

  // ——— 快捷键 ———
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newTask();
      } else if (meta && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === 'Escape') {
        setSettingsOpen(false);
        setUsageOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newTask]);

  const sendText = useCallback(async (text: string) => {
    setBusy(true);
    setError('');
    const atts = attachmentsRef.current;
    setMessages((items) => [
      ...items.map((m) => ({ ...m, streaming: false })),
      { id: uid('m'), role: 'user' as const, text, ts: Date.now() },
    ]);
    try {
      const res = await invoke<{ ok: boolean; skipped?: string[] }>('send_prompt', {
        text,
        attachments: atts.length ? atts : undefined,
      });
      setAttachments([]);
      if (res?.skipped?.length) {
        setError(`部分附件未发送：${res.skipped.join('、')}`);
      }
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }, []);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    if (busy) {
      setQueue((q) => [...q, { id: uid('q'), text }]);
      setInput('');
      return;
    }
    if (!activeSessionId) {
      const created = await start();
      if (!created) return;
    }
    setInput('');
    await sendText(text);
  }, [input, busy, activeSessionId, start, sendText]);

  // 非 busy 后自动逐条发送队列（发一条等一条）
  useEffect(() => {
    if (busy || !queue.length || !activeSessionId) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void sendText(next.text);
  }, [busy, queue, activeSessionId, sendText]);

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((item) => item.id !== id));
  }, []);

  const reorderQueued = useCallback((sourceId: string, targetId: string) => {
    setQueue((items) => {
      const from = items.findIndex((item) => item.id === sourceId);
      const to = items.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0 || from === to) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const editQueued = useCallback((id: string) => {
    const item = queue.find((queued) => queued.id === id);
    if (!item) return;
    setQueue((items) => items.filter((queued) => queued.id !== id));
    setInput(item.text);
    setComposerFocusRequest((value) => value + 1);
  }, [queue]);

  // 停止：先把所有挂起的 agent 请求回包（权限取消/抉择跳过/计划放弃），再 cancel，
  // 否则 agent 干等未回答的请求，prompt 永不完成，UI 卡死。
  const cancelActiveTurn = useCallback(async (clearQueue: boolean) => {
    if (clearQueue) setQueue([]);
    const pending: Promise<unknown>[] = [];
    if (permission) {
      pending.push(invoke('permission_reply', { requestId: permission.requestId, optionId: null }));
    }
    if (askRequest) {
      pending.push(invoke('ask_reply', { requestId: askRequest.requestId, outcome: 'skip_interview' }));
    }
    if (exitPlan) {
      pending.push(invoke('exit_plan_reply', { requestId: exitPlan.requestId, outcome: 'abandoned' }));
    }
    await Promise.allSettled(pending);
    setPermission(null);
    setAskRequest(null);
    setExitPlan(null);
    try {
      await invoke('cancel_session');
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
    setMessages((items) => items.map((m) => ({ ...m, streaming: false })));
  }, [permission, askRequest, exitPlan]);

  const onStop = useCallback(async () => {
    await cancelActiveTurn(true);
  }, [cancelActiveTurn]);

  const changeDirection = useCallback(async (id: string) => {
    const item = queue.find((queued) => queued.id === id);
    if (!item) return;
    setQueue((items) => items.filter((queued) => queued.id !== id));
    await cancelActiveTurn(false);
    await sendText(item.text);
  }, [queue, cancelActiveTurn, sendText]);

  const replyPermission = useCallback(async (optionId: string | null) => {
    setPermission((current) => {
      if (current) {
        invoke('permission_reply', { requestId: current.requestId, optionId }).catch((e) =>
          setError(String(e)),
        );
      }
      return null;
    });
  }, []);

  const replyAsk = useCallback(
    async (answers: Record<string, string | string[]>) => {
      const req = askRequest;
      if (!req) return;
      try {
        await invoke('ask_reply', { requestId: req.requestId, outcome: 'accepted', answers });
        setAskRequest(null);
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [askRequest],
  );

  const skipAsk = useCallback(async () => {
    const req = askRequest;
    if (!req) return;
    try {
      await invoke('ask_reply', { requestId: req.requestId, outcome: 'skip_interview' });
    } catch (e) {
      setError(String(e));
    }
    setAskRequest(null);
  }, [askRequest]);

  const replyExitPlan = useCallback(
    async (outcome: ExitPlanOutcome, feedback?: string) => {
      const req = exitPlan;
      if (!req) return;
      try {
        await invoke('exit_plan_reply', { requestId: req.requestId, outcome, feedback });
        setExitPlan(null);
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [exitPlan],
  );

  const onModeChange = useCallback(
    (modeId: string) => {
      saveConfig({ permissionMode: modeId });
      if (!activeSessionId) {
        setMode(modeId);
        return;
      }
      // 会话中切换会重启 agent（约 1-2s）：期间 busy，失败回退显示旧值
      if (modeBusy) return;
      setModeBusy(true);
      invoke<{ currentModeId: string }>('set_session_mode', { modeId })
        .then((res) => setMode(res.currentModeId || modeId))
        .catch((e) => setError(String(e)))
        .finally(() => setModeBusy(false));
    },
    [activeSessionId, modeBusy, saveConfig],
  );

  const onModelChange = useCallback(
    (modelId: string) => {
      setModel(modelId);
      saveConfig({ model: modelId });
      if (activeSessionId) {
        invoke('set_session_option', { configId: 'model', value: modelId }).catch((e) => setError(String(e)));
      }
    },
    [activeSessionId, saveConfig],
  );

  const onEffortChange = useCallback(
    (value: string) => {
      setEffort(value);
      saveConfig({ effort: value });
      if (activeSessionId && value) {
        invoke('set_session_option', { configId: 'reasoning_effort', value }).catch((e) =>
          setError(String(e)),
        );
      }
    },
    [activeSessionId, saveConfig],
  );

  const chooseFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: cwdRef.current || undefined,
      });
      if (typeof selected === 'string') applyCwd(selected);
    } catch (e) {
      setError(String(e));
    }
  }, [applyCwd]);

  const onSessionsChanged = useCallback(() => {
    void refreshSessions();
    void refreshCore();
  }, [refreshSessions, refreshCore]);

  const onTogglePin = useCallback(
    (id: string) => {
      const set = new Set(configRef.current.pinnedSessions);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      saveConfig({ pinnedSessions: Array.from(set) });
    },
    [saveConfig],
  );

  const onToggleHidden = useCallback(
    (id: string) => {
      const set = new Set(configRef.current.hiddenSessions);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      saveConfig({ hiddenSessions: Array.from(set) });
    },
    [saveConfig],
  );

  const renameSession = useCallback(
    async (ws: string, id: string, title: string): Promise<boolean> => {
      if (!title) return false;
      setRenameBusy(true);
      try {
        const res = await invoke<CmdResult>('rename_session', { cwd: ws, sessionId: id, title });
        if (!res.ok) throw new Error(res.output || '重命名失败');
        setSessionsByCwd((prev) => ({
          ...prev,
          [ws]: (prev[ws] || []).map((s) => (s.id === id ? { ...s, title } : s)),
        }));
        refreshSessions();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setRenameBusy(false);
      }
    },
    [refreshSessions],
  );

  const onToggleWorkspace = useCallback(
    (path: string) => {
      const set = new Set(configRef.current.collapsedWorkspaces);
      if (set.has(path)) set.delete(path);
      else set.add(path);
      saveConfig({ collapsedWorkspaces: Array.from(set) });
    },
    [saveConfig],
  );

  // SP 超能模式：始终写 config；有活动会话时同步 set_sp_enabled（后端重启 agent）
  const toggleSp = useCallback(() => {
    const next = !configRef.current.spEnabled;
    saveConfig({ spEnabled: next });
    if (!activeSessionId || spBusy) return;
    setSpBusy(true);
    invoke<{ spEnabled: boolean; restarted: boolean }>('set_sp_enabled', { enabled: next })
      .catch((e) => setError(String(e)))
      .finally(() => setSpBusy(false));
  }, [activeSessionId, spBusy, saveConfig]);

  const onSessionEnded = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setTrimmed(false);
    setPermission(null);
    setAvailableModes([]);
    setBusy(false);
  }, []);

  const onRememberNote = useCallback(async () => {
    if (!configRef.current.autoMemory) return;
    let note = input.trim();
    if (!note) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && m.text.trim()) {
          note = m.text.trim();
          break;
        }
      }
    }
    if (!note) {
      setError('没有可记住的内容');
      return;
    }
    if (!cwdRef.current) {
      setError('请先选择工作区文件夹');
      return;
    }
    setRememberState('saving');
    try {
      const res = await invoke<MemoryFile>('append_memory_note', { cwd: cwdRef.current, note });
      setRememberState('done');
      flashNotice(`已记住 → ${res.label || res.path}`);
      if (rememberTimer.current) window.clearTimeout(rememberTimer.current);
      rememberTimer.current = window.setTimeout(() => setRememberState('idle'), 1500);
    } catch (e) {
      setRememberState('idle');
      setError(String(e));
    }
  }, [input, messages, flashNotice]);

  const composerProps = {
    value: input,
    busy,
    cwd,
    commands: availableCommands,
    mode,
    modeBusy,
    availableModes,
    model,
    models: status?.models || [],
    effort,
    effortOptions,
    sessionActive: !!activeSessionId,
    onChange: setInput,
    onSend,
    onStop,
    pendingRequests: !!(permission || askRequest || exitPlan),
    onModeChange,
    onModelChange,
    onEffortChange,
    onRememberNote,
    rememberState,
    rememberDisabled: !config.autoMemory,
    attachments,
    dragOver,
    onAddAttachments: addAttachments,
    onRemoveAttachment: removeAttachment,
    focusRequest: composerFocusRequest,
  };

  return (
    <div className="app">
      <div className="shell">
        <div className="window-drag-strip" data-tauri-drag-region aria-hidden />
        <Sidebar
          cwd={cwd}
          workspaces={workspaces}
          sessionsByCwd={sessionsByCwd}
          collapsedWorkspaces={config.collapsedWorkspaces}
          onToggleWorkspace={onToggleWorkspace}
          activeSessionId={activeSessionId}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
          onNewSession={newTask}
          onSelectSession={(ws, id) => {
            if (ws !== cwd) applyCwd(ws);
            void start(id, ws);
          }}
          onChooseFolder={chooseFolder}
          onSelectCwd={applyCwd}
          onSessionsChanged={onSessionsChanged}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUsage={() => setUsageOpen(true)}
          onError={setError}
          pinnedSessions={config.pinnedSessions}
          hiddenSessions={config.hiddenSessions}
          onTogglePin={onTogglePin}
          onToggleHidden={onToggleHidden}
          onRenameSession={renameSession}
          onRestoreCodeSession={(ws, id) => {
            if (ws !== cwd) applyCwd(ws);
            void start(id, ws, true);
          }}
        />

        <div className="workspace-col">
          <div className="workspace-split">
            <section className="main-pane">
              <header className="main-header" data-tauri-drag-region>
                <div className="main-header-drag" data-tauri-drag-region aria-hidden />
                {activeSessionId && (
                  <div className="session-title" data-tauri-drag-region>
                    {headerRenaming ? (
                      <InlineRename
                        initial={activeTitle}
                        busy={renameBusy}
                        placeholder="会话名称"
                        onSubmit={(value) => {
                          setHeaderRenaming(false);
                          if (value && value !== activeTitle && activeSessionId)
                            void renameSession(cwdRef.current, activeSessionId, value);
                        }}
                        onCancel={() => setHeaderRenaming(false)}
                      />
                    ) : (
                      <>
                        <span className="session-title-text" data-tauri-drag-region>
                          {activeTitle || '未命名会话'}
                        </span>
                        <button
                          className="icon-btn tiny soft"
                          type="button"
                          title="重命名会话"
                          onClick={() => setHeaderRenaming(true)}
                        >
                          <Pencil size={12} />
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div className="main-topright">
                  <button
                    type="button"
                    className={`sp-toggle ${config.spEnabled ? 'on' : ''}`}
                    title="superpowers 超能模式（当前会话）"
                    disabled={spBusy}
                    onClick={toggleSp}
                  >
                    {spBusy ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
                    SP
                  </button>
                  <span className={`status-pill quiet ${status?.authenticated ? '' : 'warn'}`}>
                    <i className={`dot ${status?.authenticated ? '' : 'err'}`} />
                    {status?.authenticated ? 'Grok 已连接' : '需要登录'}
                  </span>
                  <button
                    className={`icon-btn ${terminalOpen ? 'active' : ''}`}
                    type="button"
                    title="终端"
                    onClick={() => setTerminalOpen((v) => !v)}
                  >
                    <SquareTerminal size={16} />
                  </button>
                  <button
                    className={`icon-btn ${rightDock === 'files' ? 'active' : ''}`}
                    type="button"
                    title="文件 / Diff"
                    onClick={() => setRightDock((d) => (d === 'files' ? null : 'files'))}
                  >
                    <Files size={16} />
                  </button>
                  <button
                    className={`icon-btn ${rightDock === 'git' ? 'active' : ''}`}
                    type="button"
                    title="Git"
                    onClick={() => setRightDock((d) => (d === 'git' ? null : 'git'))}
                  >
                    <FolderGit2 size={16} />
                  </button>
                  <button
                    className={`icon-btn ${rightDock === 'artifacts' ? 'active' : ''}`}
                    type="button"
                    title="产出物"
                    onClick={() => setRightDock((d) => (d === 'artifacts' ? null : 'artifacts'))}
                  >
                    <PanelRight size={16} />
                  </button>
                </div>
              </header>

              {!chatActive ? (
                <div className="home-layout">
                  <HomeHero
                    mode={mode}
                    spEnabled={config.spEnabled}
                    onChooseFolder={chooseFolder}
                    onNewSession={newTask}
                    onModeChange={onModeChange}
                    onToggleSp={toggleSp}
                  />
                  <div className="home-composer-wrap">
                    {error && (
                      <div className="error-banner">
                        <span>{error}</span>
                        <button type="button" aria-label="关闭错误" onClick={() => setError('')}>
                          ×
                        </button>
                      </div>
                    )}
                    {notice && (
                      <div className="notice-banner">
                        <span>{notice}</span>
                      </div>
                    )}
                    <QueueList items={queue} onChangeDirection={(id) => void changeDirection(id)} onEdit={editQueued} onRemove={removeQueued} onReorder={reorderQueued} />
                    <Composer {...composerProps} floating />
                  </div>
                </div>
              ) : (
                <div className="chat-layout">
                  <ChatPanel
                    messages={messages}
                    busy={busy}
                    trimmed={trimmed}
                    onJumpVisibilityChange={setShowJump}
                    jumpRef={jumpRef}
                  />
                  <MessageNav userMessages={userMessages} onJump={jumpToMessage} />
                  <div className="chat-composer-wrap">
                    <button
                      type="button"
                      className={`jump-pill ${showJump ? 'show' : ''}`}
                      tabIndex={showJump ? 0 : -1}
                      aria-hidden={!showJump}
                      onClick={() => jumpRef.current?.()}
                    >
                      <ArrowDown size={13} />
                      最新消息
                    </button>
                    {error && (
                      <div className="error-banner">
                        <span>{error}</span>
                        <button type="button" aria-label="关闭错误" onClick={() => setError('')}>
                          ×
                        </button>
                      </div>
                    )}
                    {notice && (
                      <div className="notice-banner">
                        <span>{notice}</span>
                      </div>
                    )}
                    {exitPlan ? (
                      <PlanExitCard request={exitPlan} onSubmit={replyExitPlan} />
                    ) : askRequest ? (
                      <AskUserCard
                        request={askRequest}
                        onSubmit={replyAsk}
                        onCancel={() => void skipAsk()}
                      />
                    ) : (
                      permission && (
                        <PermissionCard
                          permission={permission}
                          onReply={(optionId) => void replyPermission(optionId)}
                        />
                      )
                    )}
                    <QueueList items={queue} onChangeDirection={(id) => void changeDirection(id)} onEdit={editQueued} onRemove={removeQueued} onReorder={reorderQueued} />
                    {pinnedPlan && <PinnedPlan entries={pinnedPlan} />}
                    <Composer {...composerProps} floating={false} />
                  </div>
                </div>
              )}
            </section>

            <FilesDiffPanel open={rightDock === 'files'} cwd={cwd} onClose={() => setRightDock(null)} />
            <GitPanel open={rightDock === 'git'} cwd={cwd} onClose={() => setRightDock(null)} />
            <ArtifactsPanel open={rightDock === 'artifacts'} cwd={cwd} onClose={() => setRightDock(null)} />
          </div>

          <TerminalPanel open={terminalOpen} cwd={cwd} onClose={() => setTerminalOpen(false)} />
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        cwd={cwd}
        status={status}
        config={config}
        onClose={() => setSettingsOpen(false)}
        onRefreshCore={refreshCore}
        onSaveConfig={saveConfig}
        onSessionEnded={onSessionEnded}
      />

      <UsageModal
        open={usageOpen}
        cwd={cwd}
        sessionId={activeSessionId}
        onClose={() => setUsageOpen(false)}
      />
    </div>
  );
}
