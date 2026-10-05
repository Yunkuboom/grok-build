import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatPanel from '../components/ChatPanel';
import Composer from '../components/Composer';
import QueueList, { type QueuedMessage } from '../components/QueueList';
import PermissionCard from '../components/PermissionCard';
import AskUserCard from '../components/AskUserCard';
import PlanExitCard from '../components/PlanExitCard';
import grokLogo from '../assets/grok-logo.png';
import {
  companionTokenFromLocation,
  connectCompanion,
  invoke,
  listen,
} from '../bridge';
import { applyLocalePref, useI18n, t} from '../i18n';
import {
  DEFAULT_CONFIG,
  EFFORT_FALLBACK,
  normalizeConfigOptions,
  textFrom,
  uid,
  type AcpEvent,
  type AppConfig,
  type AskRequest,
  type AvailableCommand,
  type ChatMessage,
  type ConfigOptionValue,
  type CoreStatus,
  type ExitPlanRequest,
  type HistoryMessage,
  type ModelInfo,
  type PermissionRequest,
  type PlanEntry,
  type SessionEntry,
  type SessionModeInfo,
  type SessionResult,
  type ThemePreference,
} from '../types';
import { Loader2, MessageSquarePlus, Smartphone, WifiOff, X } from '../icons';

type Tab = 'chat' | 'sessions';
type Conn = 'connecting' | 'open' | 'closed' | 'error';

const MAX_MESSAGES = 400;

function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

function historyToMessages(history: HistoryMessage[] | undefined, ts?: number): ChatMessage[] {
  return (history || []).map((h) => ({
    id: uid('m'),
    role: h.role,
    text: h.text,
    toolTitle: h.toolTitle,
    toolStatus: h.status,
    ts,
  }));
}

export default function MobileApp() {
  useI18n();
  const [tokenInput, setTokenInput] = useState('');
  const [conn, setConn] = useState<Conn>('connecting');
  const [tab, setTab] = useState<Tab>('chat');
  const [error, setError] = useState('');
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [cwd, setCwd] = useState('');
  const [sessionsByCwd, setSessionsByCwd] = useState<Record<string, SessionEntry[]>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trimmed, setTrimmed] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [exitPlan, setExitPlan] = useState<ExitPlanRequest | null>(null);
  const [mode, setMode] = useState('plan');
  const [modeBusy, setModeBusy] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [effortOptions, setEffortOptions] = useState<ConfigOptionValue[]>(EFFORT_FALLBACK);
  const [availableModes, setAvailableModes] = useState<SessionModeInfo[]>([]);
  const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
  const [hasToken, setHasToken] = useState(() => !!companionTokenFromLocation());
  const jumpRef = useRef<(() => void) | null>(null);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const configRef = useRef(config);
  configRef.current = config;
  const modelRef = useRef(model);
  modelRef.current = model;
  const effortRef = useRef(effort);
  effortRef.current = effort;

  const workspaces = useMemo(() => {
    const list = [...(config.recentCwds || [])];
    if (cwd && !list.includes(cwd)) list.unshift(cwd);
    else if (cwd) return [cwd, ...list.filter((w) => w !== cwd)];
    return list;
  }, [config.recentCwds, cwd]);

  useEffect(() => {
    const pref = (config.theme || 'system') as ThemePreference;
    const apply = () => {
      const effective = resolveTheme(pref);
      document.documentElement.dataset.theme = effective;
      document.documentElement.style.colorScheme = effective;
    };
    apply();
    if (pref !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [config.theme]);

  const applySession = useCallback((result: SessionResult) => {
    setActiveSessionId(result.sessionId);
    setMessages(historyToMessages(result.history, result.historyTs));
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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => jumpRef.current?.());
    });
  }, []);

  const refreshSessions = useCallback(async (dirs?: string[]) => {
    const targets = dirs && dirs.length ? dirs : workspaces;
    for (const w of targets) {
      if (!w) continue;
      try {
        const list = await invoke<SessionEntry[]>('list_sessions', { cwd: w });
        setSessionsByCwd((prev) => ({ ...prev, [w]: list }));
      } catch {
        setSessionsByCwd((prev) => ({ ...prev, [w]: [] }));
      }
    }
  }, [workspaces]);

  const bootstrap = useCallback(async () => {
    try {
      const cfg = await invoke<AppConfig>('get_app_config');
      const merged = { ...DEFAULT_CONFIG, ...cfg };
      applyLocalePref(merged.locale);
      setConfig(merged);
      if (merged.lastCwd) setCwd(merged.lastCwd);
      if (merged.model) setModel(merged.model);
      if (merged.effort) setEffort(merged.effort);
      if (merged.permissionMode) setMode(merged.permissionMode);
      const core = await invoke<CoreStatus>('core_status');
      setStatus(core);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!hasToken) {
      setConn('closed');
      return;
    }
    let cancelled = false;
    setConn('connecting');
    connectCompanion()
      .then(() => {
        if (!cancelled) setConn('open');
      })
      .catch((e) => {
        if (!cancelled) {
          setConn('error');
          setError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasToken]);

  useEffect(() => {
    if (conn !== 'open') return;
    void bootstrap();
  }, [conn, bootstrap]);

  useEffect(() => {
    if (conn !== 'open' || !workspaces.length) return;
    void refreshSessions();
  }, [conn, workspaces, refreshSessions]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen<{ status: Conn }>('companion-connection', (payload) => {
      const st = payload?.status;
      if (st) setConn(st);
      if (st === 'open') setError('');
      if (st === 'closed') setError(t('电脑端连接已断开，正在重连…', 'Desktop connection closed. Reconnecting…'));
    }).then((fn) => unsubs.push(fn));

    listen<AppConfig>('app-config', (cfg) => {
      if (!cfg) return;
      const merged = { ...DEFAULT_CONFIG, ...cfg };
      applyLocalePref(merged.locale);
      setConfig(merged);
    }).then((fn) => unsubs.push(fn));

    listen<Record<string, unknown>>('companion-state', (snap) => {
      if (typeof snap?.cwd === 'string' && snap.cwd) setCwd(snap.cwd);
      if (typeof snap?.busy === 'boolean') setBusy(snap.busy);
      if (typeof snap?.mode === 'string' && snap.mode) setMode(snap.mode);
      if (typeof snap?.model === 'string') setModel(snap.model);
      if (typeof snap?.effort === 'string') setEffort(snap.effort);
      if (typeof snap?.sessionId === 'string' && snap.sessionId) {
        setActiveSessionId(snap.sessionId);
      }
    }).then((fn) => unsubs.push(fn));

    listen<AcpEvent>('acp-event', (payload) => {
      if (!payload) return;
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
          return [...items.map((m) => ({ ...m, streaming: false })), { id: uid('m'), role: 'user', text, ts: Date.now() }];
        });
        return;
      }
      if (payload.kind === 'session_ready') {
        const result = payload.result as SessionResult | undefined;
        if (result?.sessionId) applySession(result);
        setBusy(false);
        void refreshSessions();
        return;
      }
      if (payload.kind === 'prompt_complete') {
        setBusy(false);
        setAskRequest(null);
        setExitPlan(null);
        const meta = (payload.result?._meta ?? payload.result) as Record<string, unknown> | undefined;
        const total = typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined;
        setMessages((items) => {
          const next = items.map((m) => ({ ...m, streaming: false }));
          if (total !== undefined && next.length) {
            let idx = next.length - 1;
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === 'assistant') {
                idx = i;
                break;
              }
            }
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
        setError(payload.error || t('Grok 请求失败', 'Grok request failed'));
        return;
      }
      if (payload.kind === 'protocol_error') {
        setError(payload.error || t('ACP 协议错误', 'ACP protocol error'));
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
            { id: uid('m'), role: 'assistant', text: chunk, streaming: true, ts: Date.now() },
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
            { id: uid('m'), role: 'thought', text: chunk, streaming: true, ts: Date.now() },
          ];
        });
      } else if (kind === 'tool_call') {
        const toolId = String(update.toolCallId || uid('tool'));
        const title = String(update.title || update.toolCallId || t('工具调用', 'Tool call'));
        const detail = textFrom(update.content ?? '');
        setMessages((items) => [
          ...items.map((m) => ({ ...m, streaming: false })),
          {
            id: uid('m'),
            role: 'tool',
            text: detail,
            toolId,
            toolTitle: title,
            toolStatus: String(update.status || 'in_progress'),
            ts: Date.now(),
          },
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
                role: 'tool',
                text: detail,
                toolId,
                toolTitle: title || t('工具调用', 'Tool call'),
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
          return [...items, { id: uid('m'), role: 'plan', text: '', planEntries: entries, ts: Date.now() }];
        });
      } else if (kind === 'current_mode_update') {
        setMode(String(update.currentModeId || update.modeId || 'plan'));
      }
    }).then((fn) => unsubs.push(fn));

    return () => unsubs.forEach((fn) => fn());
  }, [applySession, refreshSessions]);

  useEffect(() => {
    if (tab !== 'chat') return;
    const id = requestAnimationFrame(() => jumpRef.current?.());
    return () => cancelAnimationFrame(id);
  }, [tab, activeSessionId]);

  useEffect(() => {
    if (messages.length > MAX_MESSAGES) {
      setMessages((items) => items.slice(-MAX_MESSAGES));
      setTrimmed(true);
    }
  }, [messages]);

  const start = useCallback(
    async (resume?: string, cwdOverride?: string) => {
      const dir = cwdOverride || cwdRef.current;
      if (!dir) {
        setError(t('电脑端还没有工作区，请先在桌面选择项目文件夹', 'The desktop has no workspace yet. Choose a project folder on the Mac.'));
        return undefined;
      }
      setBusy(true);
      setError('');
      setPermission(null);
      try {
        const result = await invoke<SessionResult>('start_session', {
          cwd: dir,
          sessionId: resume || null,
          model: modelRef.current,
          effort: effortRef.current,
          permissionMode: configRef.current.permissionMode || 'plan',
        });
        applySession(result);
        setTab('chat');
        return result;
      } catch (e) {
        setError(String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [applySession],
  );

  const sendText = useCallback(async (text: string) => {
    setBusy(true);
    setError('');
    setMessages((items) => {
      const last = items.at(-1);
      if (last?.role === 'user' && last.text === text) return items;
      return [...items.map((m) => ({ ...m, streaming: false })), { id: uid('m'), role: 'user', text, ts: Date.now() }];
    });
    try {
      await invoke('send_prompt', { text });
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

  useEffect(() => {
    if (busy || !queue.length || !activeSessionId) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void sendText(next.text);
  }, [busy, queue, activeSessionId, sendText]);

  const removeQueued = useCallback((id: string) => {
    setQueue((items) => items.filter((item) => item.id !== id));
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

  const cancelActiveTurn = useCallback(async (clearQueue: boolean) => {
    if (clearQueue) setQueue([]);
    const pending: Promise<unknown>[] = [];
    if (permission) pending.push(invoke('permission_reply', { requestId: permission.requestId, optionId: null }));
    if (askRequest) pending.push(invoke('ask_reply', { requestId: askRequest.requestId, outcome: 'skip_interview' }));
    if (exitPlan) pending.push(invoke('exit_plan_reply', { requestId: exitPlan.requestId, outcome: 'abandoned' }));
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

  const onPair = () => {
    const raw = tokenInput.trim();
    if (!raw) return;
    try {
      if (raw.startsWith('http')) {
        const u = new URL(raw);
        const t = new URLSearchParams(u.hash.replace(/^#/, '')).get('t') || u.searchParams.get('t');
        if (t) sessionStorage.setItem('grokCompanionToken', t);
        if (u.host !== window.location.host) {
          window.location.href = raw;
          return;
        }
      } else {
        sessionStorage.setItem('grokCompanionToken', raw);
        localStorage.setItem('grokCompanionToken', raw);
      }
    } catch {
      sessionStorage.setItem('grokCompanionToken', raw);
    }
    setHasToken(true);
    setError('');
  };

  const models: ModelInfo[] = Array.isArray(status?.models) ? status!.models : [];
  const sessionTitle =
    (cwd && sessionsByCwd[cwd]?.find((s) => s.id === activeSessionId)?.title) ||
    (activeSessionId ? activeSessionId.slice(0, 8) : 'Grok Build');

  if (!hasToken) {
    return (
      <div className="m-app">
        <div className="m-pair">
          <img src={grokLogo} alt="" width={40} height={40} />
          <h1>{t('连接电脑上的 Grok Build', 'Connect to Grok Build on this Mac')}</h1>
          <p>{t('在桌面设置里打开「手机联动」，用相机扫描二维码，或把链接粘贴到这里。', 'On the desktop, open Settings → Phone companion, then scan the QR code or paste the link here.')}</p>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={t('粘贴链接或令牌', 'Paste a link or token')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="m-btn" type="button" onClick={onPair} disabled={!tokenInput.trim()}>
            {t('连接', 'Connect')}</button>
        </div>
      </div>
    );
  }

  if (conn !== 'open' && !status) {
    return (
      <div className="m-app">
        <div className="m-offline">
          {conn === 'connecting' ? <Loader2 className="spin" size={28} /> : <WifiOff size={28} />}
          <h1>{conn === 'connecting' ? t('正在连接电脑…', 'Connecting to the desktop…') : t('电脑端未连接', 'Desktop is not connected')}</h1>
          <p>
            {error ||
              t('请确认 Mac 上的 Grok Build 已打开，并且设置里的「手机联动」处于开启状态。手机和电脑要在同一 Wi-Fi 或 Tailscale 网里。', 'Keep Grok Build open on the Mac with Phone companion turned on. The phone and the Mac need the same Wi-Fi or Tailscale network.')}
          </p>
          <button
            className="m-btn"
            type="button"
            onClick={() => {
              setHasToken(true);
              setConn('connecting');
              void connectCompanion().then(() => setConn('open')).catch((e) => {
                setConn('error');
                setError(String(e));
              });
            }}
          >
            {t('重试', 'Retry')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-app">
      <header className="m-header">
        <span className={`m-dot ${conn === 'open' ? 'on' : ''}`} aria-label={conn === 'open' ? t('已连接', 'Connected') : t('未连接', 'Not connected')} />
        <strong>{tab === 'sessions' ? t('会话', 'Sessions') : sessionTitle}</strong>
        {tab === 'chat' && (
          <button className="m-icon" type="button" aria-label={t('新建任务', 'New task')} onClick={() => void start()}>
            <MessageSquarePlus size={20} />
          </button>
        )}
      </header>
      {conn !== 'open' && <p className="m-banner warn">{error || t('正在重连电脑端…', 'Reconnecting to the desktop…')}</p>}
      {error && conn === 'open' && (
        <p className="m-banner">
          {error}
          <button className="m-icon" type="button" aria-label={t('关闭', 'Close')} onClick={() => setError('')}>
            <X size={16} />
          </button>
        </p>
      )}

      <div className="m-body">
        {tab === 'sessions' ? (
          <div className="m-sessions">
            <button className="m-new" type="button" onClick={() => void start()}>
              {t('新建任务', 'New task')}</button>
            {workspaces.length === 0 && <div className="m-empty">{t('电脑端还没有工作区。请先在桌面选择一个项目文件夹。', 'The desktop has no workspace yet. Choose a project folder on the Mac.')}</div>}
            {workspaces.map((ws) => (
              <section key={ws}>
                <div className="m-ws">{ws.split('/').filter(Boolean).at(-1) || ws}</div>
                {(sessionsByCwd[ws] || []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`m-row ${s.id === activeSessionId ? 'active' : ''}`}
                    onClick={() => {
                      setCwd(ws);
                      setTab('chat');
                      void start(s.id, ws);
                    }}
                  >
                    <span>
                      {s.title || s.id.slice(0, 8)}
                      <small>{s.updated || s.id}</small>
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="m-chat">
            <ChatPanel messages={messages} busy={busy} trimmed={trimmed} jumpRef={jumpRef} />
            <div className="m-dock">
              {permission && <PermissionCard permission={permission} onReply={(id) => {
                void invoke('permission_reply', { requestId: permission.requestId, optionId: id });
                setPermission(null);
              }} />}
              {askRequest && (
                <AskUserCard
                  request={askRequest}
                  onSubmit={async (answers) => {
                    await invoke('ask_reply', { requestId: askRequest.requestId, outcome: 'accepted', answers });
                    setAskRequest(null);
                  }}
                  onCancel={() => {
                    void invoke('ask_reply', { requestId: askRequest.requestId, outcome: 'skip_interview' });
                    setAskRequest(null);
                  }}
                />
              )}
              {exitPlan && (
                <PlanExitCard
                  request={exitPlan}
                  onSubmit={async (outcome, feedback) => {
                    await invoke('exit_plan_reply', { requestId: exitPlan.requestId, outcome, feedback });
                    setExitPlan(null);
                  }}
                />
              )}
              <QueueList items={queue} onChangeDirection={(id) => void changeDirection(id)} onEdit={editQueued} onRemove={removeQueued} onReorder={reorderQueued} />
              <Composer
                value={input}
                busy={busy}
                cwd={cwd}
                commands={availableCommands}
                attachments={[]}
                dragOver={false}
                onAddAttachments={() => {}}
                onRemoveAttachment={() => {}}
                allowAttachments={false}
                placeholder={cwd ? t('给 Grok 一个任务…', 'Give Grok a task…') : t('请先在「会话」里选工作区', 'Choose a workspace in Sessions first')}
                mode={mode}
                modeBusy={modeBusy}
                availableModes={availableModes}
                model={model}
                models={models}
                effort={effort}
                effortOptions={effortOptions}
                sessionActive={!!activeSessionId}
                pendingRequests={!!(permission || askRequest || exitPlan)}
                onChange={setInput}
                focusRequest={composerFocusRequest}
                onSend={() => void onSend()}
                onStop={() => void onStop()}
                onModeChange={(id) => {
                  setMode(id);
                  if (activeSessionId) {
                    setModeBusy(true);
                    invoke('set_session_mode', { modeId: id })
                      .catch((e) => setError(String(e)))
                      .finally(() => setModeBusy(false));
                  }
                }}
                onModelChange={(id) => {
                  setModel(id);
                  if (activeSessionId) invoke('set_session_option', { configId: 'model', value: id }).catch((e) => setError(String(e)));
                }}
                onEffortChange={(v) => {
                  setEffort(v);
                  if (activeSessionId && v) {
                    invoke('set_session_option', { configId: 'reasoning_effort', value: v }).catch((e) => setError(String(e)));
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      <nav className="m-tabs">
        <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          <Smartphone size={20} />
          {t('聊天', 'Chat')}</button>
        <button type="button" className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
          <MessageSquarePlus size={20} />
          {t('会话', 'Sessions')}</button>
      </nav>
    </div>
  );
}
