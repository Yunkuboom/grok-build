import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Plus, X } from '../icons';
import { t } from '../i18n';


type TermTab = {
  id: string;
  title: string;
  ptyId: string | null;
  exited?: boolean;
};

interface Props {
  open: boolean;
  cwd: string;
  onClose: () => void;
}

function uid(prefix = 't') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function shortCwd(cwd: string) {
  if (!cwd) return '~';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export default function TerminalPanel({ open, cwd, onClose }: Props) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<string, { term: Terminal; fit: FitAddon; ptyId: string }>>(new Map());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const disposeTab = useCallback(async (tabId: string, kill = true) => {
    const entry = termsRef.current.get(tabId);
    if (entry) {
      if (kill) {
        try {
          await invoke('pty_kill', { id: entry.ptyId });
        } catch {
          /* ignore */
        }
      }
      entry.term.dispose();
      termsRef.current.delete(tabId);
    }
  }, []);

  const mountPty = useCallback(async (tabId: string, titleHint?: string) => {
    const host = hostRef.current;
    if (!host) return;

    for (const [id, entry] of termsRef.current) {
      const el = entry.term.element;
      if (el) el.style.display = id === tabId ? 'block' : 'none';
    }

    if (termsRef.current.has(tabId)) {
      const entry = termsRef.current.get(tabId)!;
      if (entry.term.element) entry.term.element.style.display = 'block';
      try {
        entry.fit.fit();
        const dims = entry.fit.proposeDimensions();
        if (dims) {
          await invoke('pty_resize', { id: entry.ptyId, cols: dims.cols, rows: dims.rows });
        }
      } catch {
        /* ignore */
      }
      entry.term.focus();
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: {
        background: '#1c1c1c',
        foreground: '#e8e8ea',
        cursor: '#e8e8ea',
        selectionBackground: '#3a3d45',
        black: '#1c1c1c',
        red: '#ff6b6b',
        green: '#69db7c',
        yellow: '#ffd43b',
        blue: '#74c0fc',
        magenta: '#da77f2',
        cyan: '#66d9e8',
        white: '#e8e8ea',
        brightBlack: '#868e96',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    const dims = fit.proposeDimensions() || { cols: 80, rows: 24 };
    let ptyId: string;
    try {
      const res = await invoke<{ id: string }>('pty_create', {
        cwd: cwdRef.current || null,
        cols: dims.cols,
        rows: dims.rows,
      });
      ptyId = res.id;
    } catch (e) {
      term.writeln(t(`\r\n\x1b[31mPTY 创建失败: ${String(e)}\x1b[0m`, `\r\n\x1b[31mFailed to create PTY: ${String(e)}\x1b[0m`));
      term.dispose();
      return;
    }

    term.onData((data) => {
      invoke('pty_write', { id: ptyId, data }).catch(() => {});
    });

    termsRef.current.set(tabId, { term, fit, ptyId });
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, ptyId, title: titleHint || shortCwd(cwdRef.current) || 'shell' } : t,
      ),
    );
    term.focus();
  }, []);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    (async () => {
      try {
        unsubs.push(
          await listen<{ id: string; data: string }>('pty-output', (ev) => {
            const { id, data } = ev.payload;
            for (const entry of termsRef.current.values()) {
              if (entry.ptyId === id) {
                entry.term.write(data);
                break;
              }
            }
          }),
        );
        unsubs.push(
          await listen<{ id: string; code: number }>('pty-exit', (ev) => {
            const { id, code } = ev.payload;
            for (const [tabId, entry] of termsRef.current.entries()) {
              if (entry.ptyId === id) {
                entry.term.writeln(t(`\r\n\x1b[90m[进程退出，代码 ${code}]\x1b[0m`, `\r\n\x1b[90m[process exited, code ${code}]\x1b[0m`));
                setTabs((prev) =>
                  prev.map((t) => (t.id === tabId ? { ...t, exited: true, title: `${t.title} ✕` } : t)),
                );
                break;
              }
            }
          }),
        );
      } catch {
        /* 非 Tauri 环境（浏览器 dev）无事件桥，忽略 */
      }
    })();
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!tabs.length) {
      const id = uid('term');
      setTabs([{ id, title: shortCwd(cwd) || 'shell', ptyId: null }]);
      setActiveId(id);
      return;
    }
    if (!activeId && tabs[0]) setActiveId(tabs[0].id);
  }, [open, tabs, activeId, cwd]);

  useEffect(() => {
    if (!open || !activeId) return;
    const t = window.setTimeout(() => {
      void mountPty(activeId);
    }, 30);
    return () => window.clearTimeout(t);
  }, [open, activeId, mountPty]);

  useEffect(() => {
    if (!open || !hostRef.current) return;
    const ro = new ResizeObserver(() => {
      const entry = termsRef.current.get(activeIdRef.current);
      if (!entry) return;
      try {
        entry.fit.fit();
        const dims = entry.fit.proposeDimensions();
        if (dims) {
          invoke('pty_resize', { id: entry.ptyId, cols: dims.cols, rows: dims.rows }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    });
    ro.observe(hostRef.current);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    return () => {
      for (const [tabId] of [...termsRef.current.keys()]) {
        void disposeTab(tabId, true);
      }
    };
  }, [disposeTab]);

  if (!open) return null;

  const addTab = () => {
    const id = uid('term');
    setTabs((prev) => [...prev, { id, title: shortCwd(cwd) || 'shell', ptyId: null }]);
    setActiveId(id);
  };

  const closeTab = async (id: string) => {
    await disposeTab(id, true);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (!next.length) {
      onClose();
      return;
    }
    if (activeId === id) setActiveId(next[0].id);
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span className="terminal-title">{t('终端', 'Terminal')}</span>
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`terminal-tab ${tab.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(tab.id)}
            >
              <span>{tab.title}</span>
              <span
                className="tab-x"
                title={t('关闭标签', 'Close tab')}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <div className="terminal-header-actions">
          <button className="icon-btn tiny" type="button" title={t('新建终端', 'New terminal')} onClick={addTab}>
            <Plus size={14} />
          </button>
          <button className="icon-btn tiny" type="button" title={t('收起面板', 'Collapse panel')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="terminal-xterm-host" ref={hostRef} />
    </div>
  );
}
