import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TreeNode } from '../types';
import Markdown from './Markdown';
import { RefreshCw, X } from '../icons';
import { t } from '../i18n';


type ArtifactKind = 'md' | 'html';

type ArtifactTab = {
  path: string;
  name: string;
  kind: ArtifactKind;
  content: string;
};

interface Props {
  open: boolean;
  cwd: string;
  onClose: () => void;
}

function kindOf(path: string): ArtifactKind {
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm') ? 'html' : 'md';
}

function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.isDir) {
      if (n.children) flatten(n.children, out);
    } else {
      const lower = n.name.toLowerCase();
      if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.html') || lower.endsWith('.htm')) {
        out.push(n);
      }
    }
  }
  return out;
}

export default function ArtifactsPanel({ open, cwd, onClose }: Props) {
  const [files, setFiles] = useState<TreeNode[]>([]);
  const [tabs, setTabs] = useState<ArtifactTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const active = useMemo(
    () => tabs.find((t) => t.path === activePath) || tabs[0] || null,
    [tabs, activePath],
  );

  const refresh = useCallback(async () => {
    if (!cwd) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const tree = await invoke<TreeNode[]>('list_workdir_tree', { cwd });
      setFiles(flatten(tree));
      setError(null);
    } catch (e) {
      setError(String(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setTabs([]);
    setActivePath(null);
    void refresh();
  }, [open, cwd, refresh]);

  const openFile = async (node: TreeNode) => {
    const existing = tabs.find((t) => t.path === node.relative);
    if (existing) {
      setActivePath(existing.path);
      return;
    }
    try {
      const content = await invoke<string>('read_workdir_file', { cwd, path: node.relative });
      const tab: ArtifactTab = {
        path: node.relative,
        name: node.name,
        kind: kindOf(node.name),
        content,
      };
      setTabs((prev) => [...prev.filter((t) => t.path !== tab.path), tab]);
      setActivePath(tab.path);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const closeTab = (path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (activePath === path) setActivePath(next[0]?.path || null);
      return next;
    });
  };

  if (!open) return null;

  return (
    <aside className="artifacts-panel">
      <div className="artifacts-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={`artifact-tab ${tab.path === active?.path ? 'active' : ''}`}
            onClick={() => setActivePath(tab.path)}
            title={tab.path}
          >
            <span className={`file-badge ${tab.kind === 'html' ? 'html' : ''}`}>
              {tab.kind === 'html' ? 'H' : 'M'}
            </span>
            <span className="name">{tab.name}</span>
            <span
              className="tab-x"
              title={t('关闭', 'Close')}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
            >
              ×
            </span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="icon-btn tiny soft" type="button" title={t('刷新列表', 'Refresh list')} onClick={() => void refresh()}>
          <RefreshCw size={13} />
        </button>
        <button className="icon-btn tiny" type="button" title={t('关闭侧栏', 'Hide sidebar')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {active ? (
        <>
          <div className="artifacts-breadcrumb">
            <span className="path" title={active.path}>
              {active.path}
            </span>
          </div>
          <div className="artifacts-body">
            {active.kind === 'html' ? (
              <iframe className="html-frame" sandbox="" title={active.name} srcDoc={active.content} />
            ) : (
              <div className="md-preview">
                <Markdown>{active.content}</Markdown>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="artifacts-body">
          {error && <div className="artifacts-empty">{error}</div>}
          {loading && <div className="artifacts-empty">{t('扫描工作区…', 'Scanning the workspace…')}</div>}
          {!cwd && <div className="artifacts-empty">{t('先选择工作区，以扫描 .md / .html 产出物。', 'Choose a workspace to scan for .md / .html artifacts.')}</div>}
          {cwd && !loading && !files.length && !error && (
            <div className="artifacts-empty">{t('未在工作区找到 .md / .html 文件。', 'No .md or .html files in this workspace.')}</div>
          )}
          {!!files.length && (
            <div className="artifacts-list">
              <div className="muted pad-sm">{t('工作区中的产出物', 'Workspace artifacts')} ({files.length})</div>
              {files.map((f) => (
                <button key={f.relative} type="button" title={f.relative} onClick={() => void openFile(f)}>
                  {f.relative}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
