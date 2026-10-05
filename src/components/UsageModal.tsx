import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AcpEvent, SessionUsage, UsageStats, WorkspaceUsage } from '../types';
import { Loader2, RefreshCw, X } from '../icons';
import { t } from '../i18n';


interface Props {
  open: boolean;
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
}

/** USD = costUsdTicks / 1e10；< $0.01 显示 4 位小数，否则 2 位 */
function fmtCost(ticks: number): string {
  const usd = (ticks || 0) / 1e10;
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** token 数 k/M 缩写（如 19.0k） */
function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

const SEGMENTS = [
  { key: 'inputTokens', label: t('输入', 'Input'), color: '#3A83F7' },
  { key: 'cachedReadTokens', label: t('缓存读取', 'Cache read'), color: '#8B5CF6' },
  { key: 'outputTokens', label: t('输出', 'Output'), color: '#22C55E' },
  { key: 'reasoningTokens', label: t('推理', 'Reasoning'), color: '#F59E0B' },
] as const;

function StackedBar({ stats }: { stats: UsageStats }) {
  const parts = SEGMENTS.map((s) => ({ ...s, value: stats[s.key] || 0 }));
  const sum = parts.reduce((acc, p) => acc + p.value, 0);
  if (!sum) return <div className="usage-empty">{t('暂无 token 数据', 'No token data yet')}</div>;
  return (
    <div className="usage-bar-block">
      <div className="usage-bar">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.key}
              className="usage-seg"
              style={{ width: `${(p.value / sum) * 100}%`, background: p.color }}
              title={`${p.label} ${fmtTokens(p.value)}（${Math.round((p.value / sum) * 100)}%）`}
            />
          ))}
      </div>
      <div className="usage-legend">
        {parts.map((p) => (
          <span key={p.key} className="usage-legend-item">
            <i style={{ background: p.color }} />
            {p.label}
            <strong>{fmtTokens(p.value)}</strong>
            <em>{Math.round((p.value / sum) * 100)}%</em>
          </span>
        ))}
      </div>
    </div>
  );
}

function StatRow({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="usage-stat-row">
      {items.map((it) => (
        <span key={it.label} className="usage-stat">
          <small>{it.label}</small>
          <strong>{it.value}</strong>
        </span>
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="usage-skeleton">
      <i className="sk-bar" />
      <i className="sk-line" />
      <i className="sk-line short" />
    </div>
  );
}

export default function UsageModal({ open, cwd, sessionId, onClose }: Props) {
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceUsage | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [error, setError] = useState('');

  const loadSession = useCallback(async () => {
    if (!sessionId) {
      setSessionUsage(null);
      return;
    }
    setLoadingSession(true);
    try {
      const raw = await invoke<string>('session_usage', { sessionId });
      setSessionUsage(JSON.parse(raw) as SessionUsage);
    } catch (e) {
      setSessionUsage(null);
      setError(String(e));
    } finally {
      setLoadingSession(false);
    }
  }, [sessionId]);

  const loadWorkspace = useCallback(async () => {
    if (!cwd) {
      setWorkspace(null);
      return;
    }
    setLoadingWorkspace(true);
    try {
      setWorkspace(await invoke<WorkspaceUsage>('workspace_usage', { cwd }));
    } catch (e) {
      setWorkspace(null);
      setError(String(e));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [cwd]);

  const loadAll = useCallback(() => {
    setError('');
    void loadSession();
    void loadWorkspace();
  }, [loadSession, loadWorkspace]);

  useEffect(() => {
    if (!open) return;
    setSessionUsage(null);
    setWorkspace(null);
    loadAll();
  }, [open, loadAll]);

  // prompt_complete 后自动刷新当前会话区块
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    listen<AcpEvent>('acp-event', ({ payload }) => {
      if (payload.kind === 'prompt_complete') void loadSession();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [open, loadSession]);

  if (!open) return null;

  const sessionStats = sessionUsage?.session;
  const sessionTurns = sessionStats
    ? sessionStats.turnCount || sessionUsage?.turns?.length || 0
    : 0;
  const modelEntries = workspace
    ? Object.entries(workspace.models || {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    : [];
  const maxModelTokens = modelEntries.reduce((acc, [, st]) => Math.max(acc, st.totalTokens || 0), 0);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="modal usage-stats-modal" role="dialog" aria-modal="true" aria-label={t('Grok 用量', 'Grok usage')}>
        <div className="modal-header">
          <strong>{t('Grok 用量', 'Grok usage')}</strong>
          <div className="usage-header-actions">
            <button
              className="icon-btn"
              type="button"
              title={t('刷新', 'Refresh')}
              disabled={loadingSession || loadingWorkspace}
              onClick={loadAll}
            >
              {loadingSession || loadingWorkspace ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
            </button>
            <button className="icon-btn" type="button" title={t('关闭 (Esc)', 'Close (Esc)')} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="usage-body">
          {error && (
            <div className="error-banner usage-error">
              <span>{error}</span>
              <button type="button" aria-label={t('关闭错误', 'Dismiss error')} onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}

          <section className="usage-section">
            <div className="usage-section-title">{t('当前会话', 'This session')}</div>
            {!sessionId && <div className="usage-empty">{t('开始会话后可查看本次用量', 'Usage appears after a session starts')}</div>}
            {sessionId && loadingSession && !sessionUsage && <Skeleton />}
            {sessionId && sessionUsage && sessionStats && (
              <>
                <StackedBar stats={sessionStats} />
                <StatRow
                  items={[
                    { label: t('模型调用', 'Model calls'), value: String(sessionStats.modelCalls || 0) },
                    { label: t('轮数', 'Turns'), value: String(sessionTurns) },
                    { label: t('成本', 'Cost'), value: fmtCost(sessionStats.costUsdTicks) },
                  ]}
                />
              </>
            )}
            {sessionId && !loadingSession && !sessionUsage && !error && (
              <div className="usage-empty">{t('未取到会话用量', 'Session usage is unavailable')}</div>
            )}
          </section>

          <section className="usage-section">
            <div className="usage-section-title">{t('本工作区累计', 'Workspace total')}</div>
            {!cwd && <div className="usage-empty">{t('选择工作区后可查看累计用量', 'Choose a workspace to see total usage')}</div>}
            {cwd && loadingWorkspace && !workspace && <Skeleton />}
            {cwd && workspace && (
              <>
                <StackedBar stats={workspace.totals} />
                <StatRow
                  items={[
                    { label: t('会话数', 'Sessions'), value: String(workspace.sessionCount || 0) },
                    { label: t('总轮数', 'Total turns'), value: String(workspace.totals.turnCount || 0) },
                    { label: t('总成本', 'Total cost'), value: fmtCost(workspace.totals.costUsdTicks) },
                  ]}
                />

                {modelEntries.length > 0 && (
                  <div className="usage-models">
                    <div className="usage-sub-title">{t('按模型', 'By model')}</div>
                    {modelEntries.map(([id, st]) => (
                      <div key={id} className="usage-model-row">
                        <div className="usage-model-meta">
                          <span className="usage-model-id" title={id}>
                            {id}
                          </span>
                          <span className="usage-model-nums">
                            {fmtTokens(st.totalTokens)} · {fmtCost(st.costUsdTicks)}
                          </span>
                        </div>
                        <div className="usage-model-bar">
                          <i
                            style={{
                              width: `${maxModelTokens ? Math.max((st.totalTokens / maxModelTokens) * 100, 1.5) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {workspace.topSessions?.length > 0 && (
                  <div className="usage-top">
                    <div className="usage-sub-title">{t('用量最高的会话', 'Sessions by usage')}</div>
                    {workspace.topSessions.slice(0, 5).map((s) => (
                      <div key={s.sessionId} className="usage-top-row">
                        <span className="usage-top-title" title={s.sessionId}>
                          {s.title || s.sessionId.slice(0, 8)}
                        </span>
                        <span className="usage-top-nums">
                          {fmtTokens(s.totalTokens)} · {fmtCost(s.costUsdTicks)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {cwd && !loadingWorkspace && !workspace && !error && (
              <div className="usage-empty">{t('未取到工作区用量', 'Workspace usage is unavailable')}</div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
