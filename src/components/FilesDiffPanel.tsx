import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DiffResult, GitStatusResult, GitStatusEntry, TreeNode } from '../types';
import { RefreshCw, X } from '../icons';
import { t } from '../i18n';


interface Props {
  open: boolean;
  cwd: string;
  onClose: () => void;
}

type ViewMode = 'file' | 'diff';

function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="dock-muted">{t('无变更', 'No changes')}</div>;
  return (
    <pre className="diff-pre">
      {text.split('\n').map((line, i) => {
        let cls = 'diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) cls += ' add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' del';
        else if (line.startsWith('@@')) cls += ' hunk';
        else if (
          line.startsWith('diff ') ||
          line.startsWith('index ') ||
          line.startsWith('---') ||
          line.startsWith('+++')
        )
          cls += ' meta';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function TreeRows({
  nodes,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (rel: string) => void;
  onSelect: (n: TreeNode) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const isOpen = expanded.has(n.relative);
        return (
          <div key={n.relative || n.path}>
            <button
              type="button"
              className={`tree-row ${!n.isDir && selected === n.relative ? 'active' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => {
                if (n.isDir) onToggle(n.relative);
                else onSelect(n);
              }}
              title={n.relative}
            >
              <span className="tree-icon">{n.isDir ? (isOpen ? '▾' : '▸') : '·'}</span>
              <span className="tree-name">{n.name}</span>
            </button>
            {n.isDir && isOpen && n.children && n.children.length > 0 && (
              <TreeRows
                nodes={n.children}
                depth={depth + 1}
                selected={selected}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function FilesDiffPanel({ open, cwd, onClose }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('file');
  const [content, setContent] = useState('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [changed, setChanged] = useState<GitStatusEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshTree = useCallback(async () => {
    if (!cwd) {
      setTree([]);
      setChanged([]);
      return;
    }
    setLoading(true);
    try {
      const nodes = await invoke<TreeNode[]>('list_workdir_tree', { cwd });
      setTree(nodes);
      setError(null);
      try {
        const st = await invoke<GitStatusResult>('git_status', { cwd });
        if (st.isRepo) setChanged(st.entries.filter((e) => e.staged || e.unstaged || e.untracked));
        else setChanged([]);
      } catch {
        setChanged([]);
      }
    } catch (e) {
      setError(String(e));
      setTree([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    void refreshTree();
    setSelected(null);
    setContent('');
    setDiff(null);
  }, [open, cwd, refreshTree]);

  const loadFile = async (rel: string, preferDiff = false) => {
    setSelected(rel);
    const nextMode = preferDiff ? 'diff' : mode;
    setMode(nextMode);
    try {
      if (nextMode === 'diff') {
        const d = await invoke<DiffResult>('git_diff_file', { cwd, path: rel, staged: null });
        setDiff(d);
        setContent('');
      } else {
        const text = await invoke<string>('read_workdir_file', { cwd, path: rel });
        setContent(text);
        setDiff(null);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const switchMode = async (m: ViewMode) => {
    setMode(m);
    if (!selected) return;
    try {
      if (m === 'diff') {
        const d = await invoke<DiffResult>('git_diff_file', { cwd, path: selected, staged: null });
        setDiff(d);
      } else {
        const text = await invoke<string>('read_workdir_file', { cwd, path: selected });
        setContent(text);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleExpand = (rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  };

  if (!open) return null;

  return (
    <aside className="dock-panel files-diff-panel">
      <div className="dock-panel-header">
        <strong>{t('文件 / Diff', 'Files / diff')}</strong>
        <div className="dock-panel-actions">
          <button
            className="icon-btn tiny soft"
            type="button"
            title={t('刷新', 'Refresh')}
            onClick={() => void refreshTree()}
          >
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn tiny" type="button" title={t('关闭', 'Close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {!cwd ? (
        <div className="dock-empty">{t('请先选择工作区文件夹', 'Choose a workspace folder first')}</div>
      ) : (
        <div className="files-diff-body">
          {changed.length > 0 && (
            <div className="changed-strip">
              <div className="dock-section-label">{t('变更', 'Changes')}</div>
              {changed.slice(0, 40).map((e) => (
                <button
                  key={e.path}
                  type="button"
                  className={`changed-chip ${selected === e.path ? 'active' : ''}`}
                  title={e.path}
                  onClick={() => void loadFile(e.path, true)}
                >
                  <span className="st-code">
                    {e.untracked ? '??' : `${e.indexStatus}${e.workTreeStatus}`}
                  </span>
                  {e.path.split('/').pop()}
                </button>
              ))}
            </div>
          )}

          <div className="files-diff-split">
            <div className="files-tree">
              {loading && <div className="dock-muted pad-sm">{t('加载中…', 'Loading…')}</div>}
              {error && <div className="dock-error pad-sm">{error}</div>}
              {!loading && !tree.length && !error && (
                <div className="dock-muted pad-sm">{t('空目录或无可列文件', 'Empty folder, or nothing to list')}</div>
              )}
              <TreeRows
                nodes={tree}
                depth={0}
                selected={selected}
                expanded={expanded}
                onToggle={toggleExpand}
                onSelect={(n) => void loadFile(n.relative, false)}
              />
            </div>

            <div className="files-preview">
              <div className="files-preview-bar">
                <div className="mode-toggle">
                  <button
                    type="button"
                    className={mode === 'file' ? 'active' : ''}
                    onClick={() => void switchMode('file')}
                  >
                    {t('文件', 'File')}</button>
                  <button
                    type="button"
                    className={mode === 'diff' ? 'active' : ''}
                    onClick={() => void switchMode('diff')}
                  >
                    Diff
                  </button>
                </div>
                <span className="preview-path" title={selected || ''}>
                  {selected || t('未选择', 'Nothing selected')}
                </span>
              </div>
              <div className="files-preview-body">
                {!selected && <div className="dock-muted">{t('点击左侧文件查看内容或 Diff', 'Select a file to view its contents or diff')}</div>}
                {selected && mode === 'file' && <pre className="file-pre">{content || t('（空文件）', '(empty file)')}</pre>}
                {selected && mode === 'diff' && (
                  <>
                    {diff?.message && (
                      <div className="dock-muted" style={{ marginBottom: 8 }}>
                        {diff.message}
                      </div>
                    )}
                    <DiffView text={diff?.text || ''} />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
