import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import type { CmdResult, SessionEntry } from '../types';
import grokLogo from '../assets/grok-logo.png';
import InlineRename from './InlineRename';
import SessionMenu from './SessionMenu';
import {
  ChartColumn,
  ChevronRight,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Search,
  Settings,
  X,
} from '../icons';
import { t } from '../i18n';

interface Props {
  cwd: string;
  workspaces: string[];
  sessionsByCwd: Record<string, SessionEntry[]>;
  collapsedWorkspaces: string[];
  onToggleWorkspace: (path: string) => void;
  activeSessionId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
  onSelectSession: (ws: string, id: string) => void;
  onChooseFolder: () => void;
  onSelectCwd: (path: string) => void;
  onSessionsChanged: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onError: (message: string) => void;
  pinnedSessions: string[];
  hiddenSessions: string[];
  onTogglePin: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onRenameSession: (ws: string, id: string, title: string) => Promise<boolean>;
  onRestoreCodeSession: (ws: string, id: string) => void;
}

const shortPath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) || path || t('未选择', 'Nothing selected');
};

export default function Sidebar({
  cwd,
  workspaces,
  sessionsByCwd,
  collapsedWorkspaces,
  onToggleWorkspace,
  activeSessionId,
  collapsed,
  onToggleCollapsed,
  onNewSession,
  onSelectSession,
  onChooseFolder,
  onSelectCwd,
  onSessionsChanged,
  onOpenSettings,
  onOpenUsage,
  onError,
  pinnedSessions,
  hiddenSessions,
  onTogglePin,
  onToggleHidden,
  onRenameSession,
  onRestoreCodeSession,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [usage, setUsage] = useState<{ id: string; text: string } | null>(null);
  const [busyId, setBusyId] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [renamingId, setRenamingId] = useState('');
  const [menu, setMenu] = useState<{ s: SessionEntry; ws: string; x: number; y: number } | null>(
    null,
  );
  const [toast, setToast] = useState('');
  const searchGen = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const marqueeTimer = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 1500);
  };

  // ——— 标题走马灯：仅 hover 且确实溢出时滚动 ———
  const marqueeEnter = (e: React.MouseEvent<HTMLElement>) => {
    const btn = e.currentTarget;
    const wrap = btn.querySelector<HTMLElement>('.title');
    const text = btn.querySelector<HTMLElement>('.marquee-text');
    if (!wrap || !text) return;
    const overflow = text.scrollWidth - wrap.clientWidth;
    if (overflow <= 2) return;
    const dur = overflow / 60;
    text.style.setProperty('--marquee-shift', `${-overflow}px`);
    text.style.setProperty('--marquee-dur', `${dur}s`);
    text.style.transitionDelay = '0.4s';
    btn.classList.add('marquee-active');
    if (marqueeTimer.current) window.clearTimeout(marqueeTimer.current);
    marqueeTimer.current = window.setTimeout(() => {
      text.style.transitionDelay = '0s';
      text.style.setProperty('--marquee-shift', '0px');
    }, (0.4 + dur + 0.6) * 1000);
  };

  const marqueeLeave = (e: React.MouseEvent<HTMLElement>) => {
    const btn = e.currentTarget;
    if (marqueeTimer.current) {
      window.clearTimeout(marqueeTimer.current);
      marqueeTimer.current = null;
    }
    btn.classList.remove('marquee-active');
    const text = btn.querySelector<HTMLElement>('.marquee-text');
    if (text) {
      text.style.removeProperty('--marquee-shift');
      text.style.removeProperty('--marquee-dur');
      text.style.transitionDelay = '';
    }
  };

  // 搜索只在当前 cwd 进行；搜索态切回平铺结果
  useEffect(() => {
    const q = query.trim();
    if (!q || !cwd) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const gen = ++searchGen.current;
    const timer = window.setTimeout(() => {
      invoke<SessionEntry[]>('search_sessions', { cwd, query: q })
        .then((list) => {
          if (gen !== searchGen.current) return;
          setResults(list);
          setSearching(false);
        })
        .catch((e) => {
          if (gen !== searchGen.current) return;
          setResults([]);
          setSearching(false);
          onError(String(e));
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, cwd, onError]);

  const isSearching = results !== null;
  const hiddenSet = useMemo(() => new Set(hiddenSessions), [hiddenSessions]);
  const pinSet = useMemo(() => new Set(pinnedSessions), [pinnedSessions]);
  const collapsedSet = useMemo(() => new Set(collapsedWorkspaces), [collapsedWorkspaces]);
  const hiddenCount = useMemo(
    () =>
      Object.values(sessionsByCwd)
        .flat()
        .filter((s) => hiddenSet.has(s.id)).length,
    [sessionsByCwd, hiddenSet],
  );

  const visibleOf = (ws: string) =>
    (sessionsByCwd[ws] || [])
      .filter((s) => !hiddenSet.has(s.id) || showHidden)
      .sort((a, b) => Number(pinSet.has(b.id)) - Number(pinSet.has(a.id)));

  const searchVisible = useMemo(() => {
    if (!isSearching) return [];
    return (results ?? [])
      .filter((s) => !hiddenSet.has(s.id))
      .sort((a, b) => Number(pinSet.has(b.id)) - Number(pinSet.has(a.id)));
  }, [isSearching, results, hiddenSet, pinSet]);

  const exportSession = async (s: SessionEntry) => {
    setBusyId(s.id);
    try {
      const markdown = await invoke<string>('export_session', { sessionId: s.id });
      await navigator.clipboard.writeText(markdown);
      showToast(t('已复制会话 Markdown', 'Session Markdown copied'));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId('');
    }
  };

  const copyId = async (s: SessionEntry) => {
    try {
      await navigator.clipboard.writeText(s.id);
      showToast(t('已复制 Session ID', 'Session ID copied'));
    } catch (e) {
      onError(String(e));
    }
  };

  const deleteSession = async (s: SessionEntry) => {
    if (!window.confirm(t(`删除会话「${s.title || s.id.slice(0, 8)}」？此操作不可恢复。`, `Delete session “${s.title || s.id.slice(0, 8)}”? This cannot be undone.`))) return;
    setBusyId(s.id);
    try {
      const res = await invoke<CmdResult>('delete_session', { sessionId: s.id });
      if (!res.ok) throw new Error(res.output || t('删除失败', 'Delete failed'));
      onSessionsChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId('');
    }
  };

  const showUsage = async (s: SessionEntry) => {
    setBusyId(s.id);
    try {
      const text = await invoke<string>('session_usage', { sessionId: s.id });
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* 原始文本直接展示 */
      }
      setUsage({ id: s.id, text: pretty });
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId('');
    }
  };

  const submitRename = async (ws: string, s: SessionEntry, value: string) => {
    setRenamingId('');
    if (!value || value === s.title) return;
    setBusyId(s.id);
    await onRenameSession(ws, s.id, value);
    setBusyId('');
  };

  const truncateMiddle = (text: string, max = 44) =>
    text.length > max ? `${text.slice(0, 22)}…${text.slice(-18)}` : text;

  const forkSession = async (ws: string, s: SessionEntry) => {
    setBusyId(s.id);
    try {
      const res = await invoke<{ newSessionId?: string }>('fork_session', {
        cwd: ws,
        sessionId: s.id,
      });
      onSessionsChanged();
      const newId = String(res?.newSessionId || '');
      showToast(t(`已分叉（新会话 ${newId ? `${newId.slice(0, 8)}…` : '已创建'}）`, `Forked (new session ${newId ? `${newId.slice(0, 8)}…` : 'created'})`));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId('');
    }
  };

  const exportTrace = async (s: SessionEntry) => {
    setBusyId(s.id);
    try {
      const res = await invoke<CmdResult>('export_trace', { sessionId: s.id });
      if (!res.ok) throw new Error(res.output || t('导出失败', 'Export failed'));
      showToast(t(`trace 已导出：${truncateMiddle(res.output.trim())}`, `Trace exported: ${truncateMiddle(res.output.trim())}`));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId('');
    }
  };

  const revealInFinder = (path: string) => {
    invoke('open_in_finder', { path }).catch((e) => onError(String(e)));
  };

  const renderSessionRow = (ws: string, s: SessionEntry) => (
    <div
      key={s.id}
      className={`session-row ${s.id === activeSessionId ? 'active' : ''} ${hiddenSet.has(s.id) ? 'is-hidden' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ s, ws, x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        className={`session-gutter-pin ${pinSet.has(s.id) ? 'pinned' : ''}`}
        title={pinSet.has(s.id) ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')}
        aria-label={pinSet.has(s.id) ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(s.id);
        }}
      >
        <Pin size={12} />
      </button>
      {renamingId === s.id ? (
        <InlineRename
          initial={s.title}
          busy={busyId === s.id}
          placeholder={t('会话名称', 'Session name')}
          onSubmit={(value) => void submitRename(ws, s, value)}
          onCancel={() => setRenamingId('')}
        />
      ) : (
        <>
          <button
            type="button"
            className="session-row-main"
            onClick={() => onSelectSession(ws, s.id)}
            onMouseEnter={marqueeEnter}
            onMouseLeave={marqueeLeave}
          >
            <span className="title">
              <span className="marquee-text">{s.title || t('未命名会话', 'Untitled session')}</span>
            </span>
            {busyId === s.id && <Loader2 size={12} className="spin row-busy" />}
          </button>
          <button
            type="button"
            className="icon-btn tiny row-more-btn"
            title={t('更多操作', 'More actions')}
            aria-label={t(`会话 ${s.title || s.id.slice(0, 8)} 更多操作`, `More actions for ${s.title || s.id.slice(0, 8)}`)}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ s, ws, x: r.right, y: r.bottom + 4 });
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <div className="sidebar-drag-strip" data-tauri-drag-region aria-hidden />
        <button className="icon-btn" type="button" title={t('展开侧栏', 'Show sidebar')} onClick={onToggleCollapsed}>
          <PanelLeftOpen size={16} />
        </button>
        <button className="icon-btn" type="button" title={t('新建任务 ⌘N', 'New task ⌘N')} onClick={onNewSession}>
          <MessageSquarePlus size={16} />
        </button>
        <div className="sidebar-collapsed-spacer" />
        <button className="icon-btn" type="button" title={t('Grok 用量', 'Grok usage')} onClick={onOpenUsage}>
          <ChartColumn size={16} />
        </button>
        <button className="icon-btn" type="button" title={t('设置 ⌘,', 'Settings ⌘,')} onClick={onOpenSettings}>
          <Settings size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-topnav" data-tauri-drag-region>
        <button className="icon-btn" type="button" title={t('收起侧栏', 'Collapse sidebar')} onClick={onToggleCollapsed}>
          <PanelLeftClose size={16} />
        </button>
        <div className="brand" data-tauri-drag-region>
          <img className="brand-mark" src={grokLogo} alt="" draggable={false} />
          <span className="brand-name">Grok Build</span>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="side-action" type="button" onClick={onNewSession}>
          <MessageSquarePlus size={16} />
          <span>{t('新建任务', 'New task')}</span>
          <kbd>⌘N</kbd>
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={13} aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('搜索会话…', 'Search sessions…')}
          aria-label={t('搜索会话', 'Search sessions')}
        />
        {query && (
          <button className="icon-btn tiny" type="button" title={t('清空', 'Clear')} onClick={() => setQuery('')}>
            <X size={12} />
          </button>
        )}
      </div>

      <div className="sidebar-scroll">
        <div className="section-label sessions-label">
          {t('工作区与会话', 'Workspaces and sessions')}
          {searching && <Loader2 size={12} className="spin" />}
        </div>

        {isSearching ? (
          <div className="session-block">
            {!searchVisible.length && (
              <p className="muted pad-sm">{searching ? t('搜索中…', 'Searching…') : t('没有匹配的会话', 'No matching sessions')}</p>
            )}
            {searchVisible.map((s) => renderSessionRow(cwd, s))}
          </div>
        ) : (
          <div className="ws-tree">
            {workspaces.map((w) => {
              const isCollapsed = collapsedSet.has(w);
              const list = visibleOf(w);
              return (
                <div key={w} className="ws-block">
                  <div className="ws-row">
                    <button
                      type="button"
                      className="ws-chevron"
                      title={isCollapsed ? t('展开', 'Expand') : t('折叠', 'Collapse')}
                      aria-label={isCollapsed ? t('展开工作区', 'Expand workspace') : t('折叠工作区', 'Collapse workspace')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleWorkspace(w);
                      }}
                    >
                      <ChevronRight size={12} className={isCollapsed ? '' : 'open'} />
                    </button>
                    <button
                      type="button"
                      className="ws-row-main"
                      title={w}
                      onClick={() => {
                        if (w !== cwd) onSelectCwd(w);
                        if (isCollapsed) onToggleWorkspace(w);
                      }}
                    >
                      <FolderOpen size={14} className="ws-folder-icon" />
                      <span className="ws-meta">
                        <strong>{shortPath(w)}</strong>
                        <small>{w}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn tiny ws-finder-btn"
                      title={t('在访达中打开', 'Show in Finder')}
                      onClick={(e) => {
                        e.stopPropagation();
                        revealInFinder(w);
                      }}
                    >
                      <FolderOpen size={12} />
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="ws-sessions">
                      {!list.length && <p className="muted ws-empty">{t('暂无会话', 'No sessions')}</p>}
                      {list.map((s) => renderSessionRow(w, s))}
                    </div>
                  )}
                </div>
              );
            })}
            <button type="button" className="show-more" onClick={onChooseFolder}>
              <Plus size={12} /> {t('添加工作区…', 'Add workspace…')}
            </button>
            {hiddenCount > 0 && (
              <button type="button" className="show-more" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? t('收起已隐藏', 'Hide hidden sessions') : t(`显示已隐藏（${hiddenCount}）`, `Show hidden (${hiddenCount})`)}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-settings" type="button" onClick={onOpenSettings}>
          <Settings size={16} />
          <span>{t('设置', 'Settings')}</span>
          <kbd>⌘,</kbd>
        </button>
        <button className="icon-btn" type="button" title={t('Grok 用量', 'Grok usage')} onClick={onOpenUsage}>
          <ChartColumn size={16} />
        </button>
      </div>

      {menu &&
        createPortal(
          <SessionMenu
            x={menu.x}
            y={menu.y}
            session={menu.s}
            pinned={pinSet.has(menu.s.id)}
            hidden={hiddenSet.has(menu.s.id)}
            onClose={() => setMenu(null)}
            onRename={() => setRenamingId(menu.s.id)}
            onCopyId={() => void copyId(menu.s)}
            onUsage={() => void showUsage(menu.s)}
            onFork={() => void forkSession(menu.ws, menu.s)}
            onExportTrace={() => void exportTrace(menu.s)}
            onExport={() => void exportSession(menu.s)}
            onRestoreCode={() => onRestoreCodeSession(menu.ws, menu.s.id)}
            onTogglePin={() => onTogglePin(menu.s.id)}
            onToggleHidden={() => onToggleHidden(menu.s.id)}
            onDelete={() => void deleteSession(menu.s)}
          />,
          document.body,
        )}

      {toast && createPortal(<div className="sidebar-toast">{toast}</div>, document.body)}

      {usage &&
        createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setUsage(null);
            }}
          >
            <section
              className="modal usage-modal"
              role="dialog"
              aria-modal="true"
              aria-label={t('会话用量', 'Session usage')}
            >
              <div className="modal-header">
                <strong>{t('会话用量', 'Session usage')} · {usage.id.slice(0, 8)}</strong>
                <button
                  className="icon-btn"
                  type="button"
                  title={t('关闭', 'Close')}
                  onClick={() => setUsage(null)}
                >
                  <X size={16} />
                </button>
              </div>
              <pre className="usage-pre">{usage.text}</pre>
            </section>
          </div>,
          document.body,
        )}
    </aside>
  );
}
