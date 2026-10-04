import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DiffResult, GitBranchesResult, GitStatusEntry, GitStatusResult } from '../types';
import { RefreshCw, X } from '../icons';

interface Props {
  open: boolean;
  cwd: string;
  onClose: () => void;
}

function DiffLines({ text }: { text: string }) {
  if (!text.trim()) return <div className="dock-muted pad-sm">无差异内容</div>;
  return (
    <pre className="diff-pre">
      {text.split('\n').map((line, i) => {
        let cls = 'diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) cls += ' add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' del';
        else if (line.startsWith('@@')) cls += ' hunk';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls += ' meta';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export default function GitPanel({ open, cwd, onClose }: Props) {
  const [branch, setBranch] = useState('');
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isRepo, setIsRepo] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setIsRepo(false);
      setError('未选择工作目录');
      setEntries([]);
      setBranch('');
      setBranches([]);
      setWarning(null);
      return;
    }
    setBusy(true);
    setInfo(null);
    try {
      const st = await invoke<GitStatusResult>('git_status', { cwd });
      setIsRepo(st.isRepo);
      setBranch(st.branch || '');
      setEntries(st.entries || []);
      setError(st.error || null);
      setWarning(st.warning || null);
      if (st.isRepo) {
        try {
          const br = await invoke<GitBranchesResult>('git_branches', { cwd });
          setBranches(br.branches || []);
          if (br.current) setBranch(br.current);
          if (br.error && !st.error) setError(br.error);
        } catch (e) {
          setError(String(e));
        }
      } else {
        setBranches([]);
      }
    } catch (e) {
      setIsRepo(false);
      setError(String(e));
      setEntries([]);
      setWarning(null);
    } finally {
      setBusy(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setDiffFor(null);
    setDiff(null);
    void refresh();
  }, [open, cwd, refresh]);

  const staged = useMemo(() => entries.filter((e) => e.staged && !e.untracked), [entries]);
  const changed = useMemo(() => entries.filter((e) => e.unstaged && !e.untracked), [entries]);
  const untracked = useMemo(() => entries.filter((e) => e.untracked), [entries]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const onStage = (paths: string[]) =>
    run(async () => {
      await invoke('git_stage', { cwd, paths });
      setInfo(`已暂存 ${paths.length} 个文件`);
    });

  const onUnstage = (paths: string[]) =>
    run(async () => {
      await invoke('git_unstage', { cwd, paths });
      setInfo(`已取消暂存 ${paths.length} 个文件`);
    });

  const onCommit = () =>
    run(async () => {
      const msg = message.trim();
      if (!msg) throw new Error('提交说明不能为空');
      const out = await invoke<string>('git_commit', { cwd, message: msg });
      setMessage('');
      setInfo(out || '提交成功');
    });

  const onCheckout = (name: string) =>
    run(async () => {
      await invoke('git_checkout', { cwd, branch: name });
      setInfo(`已切换到 ${name}`);
    });

  const showDiff = async (path: string, isStaged: boolean) => {
    if (diffFor === path) {
      setDiffFor(null);
      setDiff(null);
      return;
    }
    setDiffFor(path);
    setDiff(null);
    try {
      const d = await invoke<DiffResult>('git_diff_file', { cwd, path, staged: isStaged });
      setDiff(d);
    } catch (e) {
      setDiff({ ok: false, text: '', message: String(e) });
    }
  };

  if (!open) return null;

  const fileRow = (e: GitStatusEntry, kind: 'staged' | 'changed' | 'untracked') => (
    <div key={`${kind}-${e.path}`} className="git-file-row">
      <span className="st-code">
        {kind === 'untracked' ? '??' : kind === 'staged' ? e.indexStatus : e.workTreeStatus}
      </span>
      <button
        type="button"
        className={`git-path git-path-btn ${diffFor === e.path ? 'active' : ''}`}
        title={`${e.path}（点击查看 diff）`}
        onClick={() => void showDiff(e.path, kind === 'staged')}
      >
        {e.path}
      </button>
      {kind === 'staged' ? (
        <button type="button" disabled={busy} onClick={() => void onUnstage([e.path])}>
          取消
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void onStage([e.path])}>
          暂存
        </button>
      )}
    </div>
  );

  return (
    <aside className="dock-panel git-panel">
      <div className="dock-panel-header">
        <div className="git-branch-title">
          <strong>Git</strong>
          {isRepo && branch && <span className="branch-pill">{branch}</span>}
        </div>
        <div className="dock-panel-actions">
          <button
            className="icon-btn tiny soft"
            type="button"
            title="刷新"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn tiny" type="button" title="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="git-panel-body">
        {!cwd && <div className="dock-empty">请先选择工作区文件夹</div>}
        {cwd && busy && <div className="dock-muted pad-sm">加载中…</div>}
        {cwd && error && !isRepo && <div className="dock-empty">{error}</div>}
        {cwd && isRepo && (
          <>
            {warning && <div className="dock-info">{warning}</div>}
            {error && <div className="dock-error">{error}</div>}
            {info && <div className="dock-info">{info}</div>}

            <section className="git-section">
              <div className="git-section-head">
                <span>已暂存（{staged.length}）</span>
                <button
                  type="button"
                  className="linkish"
                  disabled={busy || !staged.length}
                  onClick={() => void onUnstage(staged.map((e) => e.path))}
                >
                  全部取消
                </button>
              </div>
              {!staged.length && <div className="dock-muted pad-sm">无</div>}
              {staged.map((e) => fileRow(e, 'staged'))}
            </section>

            <section className="git-section">
              <div className="git-section-head">
                <span>已更改（{changed.length}）</span>
                <button
                  type="button"
                  className="linkish"
                  disabled={busy || !(changed.length + untracked.length)}
                  onClick={() =>
                    void onStage([...changed.map((e) => e.path), ...untracked.map((e) => e.path)])
                  }
                >
                  全部暂存
                </button>
              </div>
              {!changed.length && <div className="dock-muted pad-sm">无</div>}
              {changed.map((e) => fileRow(e, 'changed'))}
            </section>

            <section className="git-section">
              <div className="git-section-head">
                <span>未跟踪（{untracked.length}）</span>
              </div>
              {!untracked.length && <div className="dock-muted pad-sm">无</div>}
              {untracked.map((e) => fileRow(e, 'untracked'))}
            </section>

            {diffFor && (
              <section className="git-section git-diff-view">
                <div className="git-section-head">
                  <span className="preview-path" title={diffFor}>
                    {diffFor}
                  </span>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      setDiffFor(null);
                      setDiff(null);
                    }}
                  >
                    关闭
                  </button>
                </div>
                {diff ? (
                  <>
                    {diff.message && <div className="dock-muted pad-sm">{diff.message}</div>}
                    <DiffLines text={diff.text} />
                  </>
                ) : (
                  <div className="dock-muted pad-sm">加载 diff…</div>
                )}
              </section>
            )}

            <section className="git-section">
              <div className="git-section-head">
                <span>提交</span>
              </div>
              <textarea
                className="git-commit-msg"
                rows={3}
                placeholder="提交说明…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                type="button"
                className="git-commit-btn"
                disabled={busy || !message.trim() || !staged.length}
                title={!staged.length ? '没有已暂存的变更' : ''}
                onClick={() => void onCommit()}
              >
                提交{staged.length ? `（${staged.length} 个文件）` : ''}
              </button>
            </section>

            <section className="git-section">
              <div className="git-section-head">
                <span>分支</span>
              </div>
              <select
                className="git-branch-select"
                value={branch}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && v !== branch) void onCheckout(v);
                }}
              >
                {branch && !branches.includes(branch) && <option value={branch}>{branch}</option>}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
