import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, CmdResult, CompanionStatus, CoreStatus, MemoryFile, MemoStatus } from '../types';
import { EFFORT_FALLBACK, PERMISSION_MODES } from '../types';
import {
  Brain,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  Server,
  Shield,
  Smartphone,
  Stethoscope,
  Store,
  Sun,
  Trash2,
  Unlink,
  Wrench,
  X,
} from '../icons';

type Section = 'accountModel' | 'cli' | 'companion' | 'mcp' | 'plugin' | 'memory' | 'theme' | 'diagnostics';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'accountModel', label: '账号与模型' },
  { id: 'cli', label: 'CLI 内核' },
  { id: 'companion', label: '手机联动' },
  { id: 'mcp', label: 'MCP 服务器' },
  { id: 'plugin', label: '插件' },
  { id: 'memory', label: '记忆与 Worktree' },
  { id: 'theme', label: '主题' },
  { id: 'diagnostics', label: '诊断' },
];

interface Props {
  open: boolean;
  cwd: string;
  status: CoreStatus | null;
  config: AppConfig;
  onClose: () => void;
  onRefreshCore: () => Promise<void>;
  onSaveConfig: (patch: Partial<AppConfig>) => void;
  onSessionEnded: () => void;
}

type McpItem = { name: string; detail: string; enabled: boolean };
type PluginItem = { name: string; detail: string; enabled: boolean };
type WorktreeItem = { id: string; detail: string };

function normalizeList(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['servers', 'plugins', 'items', 'list', 'worktrees']) {
      if (Array.isArray(o[key])) {
        return (o[key] as unknown[]).filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

function normalizeMcp(raw: unknown): McpItem[] {
  return normalizeList(raw).map((it) => {
    const name = String(it.name ?? it.id ?? '未命名');
    const command = it.command ?? it.url ?? it.commandOrUrl ?? '';
    const transport = it.transport ?? it.type ?? '';
    const statusRaw = String(it.status ?? '').toLowerCase();
    const enabled =
      typeof it.enabled === 'boolean'
        ? it.enabled
        : typeof it.disabled === 'boolean'
          ? !it.disabled
          : statusRaw
            ? statusRaw !== 'disabled'
            : true;
    return {
      name,
      detail: [String(command || ''), transport ? String(transport) : ''].filter(Boolean).join(' · '),
      enabled,
    };
  });
}

function normalizePlugins(raw: unknown): PluginItem[] {
  return normalizeList(raw).map((it) => {
    const name = String(it.name ?? it.id ?? '未命名');
    // 后端实测可靠返回 enabled（~/.grok/config.toml [plugins].disabled），直接用，不从 status 推断
    const enabled = typeof it.enabled === 'boolean' ? it.enabled : true;
    const detail = String(it.source ?? it.url ?? it.path ?? it.version ?? '');
    return { name, detail, enabled };
  });
}

function normalizeWorktrees(raw: unknown): WorktreeItem[] {
  return normalizeList(raw).map((it) => {
    const id = String(it.id ?? it.name ?? it.path ?? '');
    const detail = [it.path, it.branch].filter(Boolean).map(String).join(' · ');
    return { id, detail };
  });
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}

export default function SettingsModal({
  open,
  cwd,
  status,
  config,
  onClose,
  onRefreshCore,
  onSaveConfig,
  onSessionEnded,
}: Props) {
  const [section, setSection] = useState<Section>('accountModel');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ section: Section; text: string } | null>(null);
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const noteIn = (text: string) => setNote({ section: sectionRef.current, text });
  const [output, setOutput] = useState<{ section: Section; text: string } | null>(null);
  const sectionOutput = (sec: Section, text: string) => setOutput({ section: sec, text });

  // MCP
  const [mcpItems, setMcpItems] = useState<McpItem[] | null>(null);
  const [mcpName, setMcpName] = useState('');
  const [mcpTarget, setMcpTarget] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');

  // 插件
  const [plugins, setPlugins] = useState<PluginItem[] | null>(null);
  const [pluginSource, setPluginSource] = useState('');
  const [markets, setMarkets] = useState<Array<{ name: string; detail: string }> | null>(null);
  const [marketSource, setMarketSource] = useState('');

  // 诊断
  const [diskUsage, setDiskUsage] = useState<{
    grokHome: string;
    totalBytes: number;
    volumeAvailableBytes?: number;
    topDirs: Array<{ name: string; bytes: number }>;
  } | null>(null);

  // 记忆 / Worktree
  const [memoryScope, setMemoryScope] = useState<'workspace' | 'global' | 'all'>('workspace');
  const [worktrees, setWorktrees] = useState<WorktreeItem[] | null>(null);
  const [gcAge, setGcAge] = useState('7d');
  const [dbCommand, setDbCommand] = useState<'stats' | 'rebuild' | 'path'>('stats');
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[] | null>(null);
  const [activeMemoryPath, setActiveMemoryPath] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoStatus, setMemoStatus] = useState<MemoStatus | null>(null);
  const [memoQuery, setMemoQuery] = useState('');
  const [memoResult, setMemoResult] = useState('');

  // CLI 内核
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{ text: string; raw: string } | null>(null);

  const [companion, setCompanion] = useState<CompanionStatus | null>(null);

  const flash = (msg: string) => noteIn(msg);

  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setNote(null);
    try {
      const msg = await fn();
      if (msg) noteIn(msg);
    } catch (e) {
      noteIn(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadMcp = useCallback(
    () =>
      run(async () => {
        const raw = await invoke<unknown>('mcp_list');
        setMcpItems(normalizeMcp(raw));
      }),
    [run],
  );

  const loadPlugins = useCallback(
    () =>
      run(async () => {
        const raw = await invoke<unknown>('plugin_list');
        setPlugins(normalizePlugins(raw));
      }),
    [run],
  );

  const loadWorktrees = useCallback(
    () =>
      run(async () => {
        const raw = await invoke<unknown>('worktree_list');
        setWorktrees(normalizeWorktrees(raw));
      }),
    [run],
  );

  const loadMemoryFiles = useCallback(
    () =>
      run(async () => {
        setMemoryFiles(await invoke<MemoryFile[]>('list_memory_files'));
      }),
    [run],
  );

  const loadMemoStatus = useCallback(async () => {
    try {
      setMemoStatus(await invoke<MemoStatus>('memo_kb_status'));
    } catch (e) {
      setMemoStatus({ available: false, detail: String(e) });
    }
  }, []);

  const loadMarkets = useCallback(
    () =>
      run(async () => {
        const raw = await invoke<unknown>('marketplace_list');
        setMarkets(
          normalizeList(raw).map((it) => ({
            name: String(it.name ?? it.source ?? it.url ?? it.id ?? '未命名源'),
            detail: String(it.url ?? it.address ?? it.source ?? ''),
          })),
        );
      }),
    [run],
  );

  useEffect(() => {
    if (!open) return;
    setNote(null);
    setOutput(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (section === 'mcp' && mcpItems === null) void loadMcp();
    if (section === 'plugin') {
      if (plugins === null) void loadPlugins();
      if (markets === null) void loadMarkets();
    }
    if (section === 'companion' && companion === null) {
      void run(async () => {
        setCompanion(await invoke<CompanionStatus>('companion_status'));
      });
    }
    if (section === 'memory') {
      if (worktrees === null) void loadWorktrees();
      if (memoryFiles === null) void loadMemoryFiles();
      if (memoStatus === null) void loadMemoStatus();
    }
  }, [
    open,
    section,
    mcpItems,
    plugins,
    markets,
    worktrees,
    memoryFiles,
    memoStatus,
    loadMcp,
    loadPlugins,
    loadMarkets,
    loadWorktrees,
    loadMemoryFiles,
    loadMemoStatus,
  ]);

  if (!open) return null;

  const cmdNote = (res: CmdResult, okText: string) => (res.ok ? okText : res.output || '命令失败');

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-header">
          <strong>设置</strong>
          <button className="icon-btn" type="button" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={section === s.id ? 'active' : ''}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-body">
            {note && note.section === section && <div className="settings-note">{note.text}</div>}

            {section === 'accountModel' && (
              <>
                <div className="setting-card">
                  <div className="setting-title">
                    <span>
                      <i className={`status-dot ${status?.authenticated ? 'online' : ''}`} />
                      <strong>Grok 官方账户</strong>
                    </span>
                    <small>{status?.authMessage || (status ? '' : '检测中…')}</small>
                  </div>
                  <div className="field-btn-row">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await invoke('launch_login');
                          return '已在终端打开 grok login --oauth';
                        })
                      }
                    >
                      <LogIn size={14} />
                      在终端登录
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await invoke('launch_device_login');
                          return '已在终端打开设备码登录';
                        })
                      }
                    >
                      <LogIn size={14} />
                      设备码登录
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy || !status?.authenticated}
                      onClick={() => {
                        if (!window.confirm('退出登录将结束活动会话，并影响终端共用的 grok。继续？')) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('logout');
                          onSessionEnded();
                          await onRefreshCore();
                          return cmdNote(res, '已退出登录');
                        });
                      }}
                    >
                      <LogOut size={14} />
                      退出登录
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await onRefreshCore();
                          return '状态已刷新';
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      刷新状态
                    </button>
                  </div>
                </div>
                <label className="field">
                  <span>
                    <Cpu size={13} /> 默认模型（新会话生效）
                  </span>
                  <select value={config.model} onChange={(e) => onSaveConfig({ model: e.target.value })}>
                    <option value="">跟随 CLI 默认</option>
                    {status?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.isDefault ? '（默认）' : ''}
                      </option>
                    ))}
                    {config.model && !status?.models.some((m) => m.id === config.model) && (
                      <option value={config.model}>{config.model}</option>
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>
                    <Brain size={13} /> 推理强度（新会话生效）
                  </span>
                  <select value={config.effort} onChange={(e) => onSaveConfig({ effort: e.target.value })}>
                    <option value="">跟随 CLI 默认</option>
                    {EFFORT_FALLBACK.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>
                    <Shield size={13} /> 默认权限模式（新会话生效）
                  </span>
                  <select
                    value={config.permissionMode}
                    onChange={(e) => onSaveConfig({ permissionMode: e.target.value })}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">会话进行中可在输入框工具栏临时切换模型、强度与权限模式。</p>
              </>
            )}

            {section === 'cli' && (
              <>
                <div className="field">
                  <span>CLI 路径</span>
                  <code className="static-code">{status?.cliPath || '检测中…'}</code>
                  <small>与终端共用 ~/.grok 登录、会话及配置。</small>
                </div>
                <div className="field">
                  <span>当前版本</span>
                  <code className="static-code">{status?.version || '检测中…'}</code>
                </div>
                <div className="setting-card">
                  <div>
                    <strong>更新内核</strong>
                    <small>更新会影响终端共用的 grok，并结束本应用中的活动会话。</small>
                  </div>
                  <div className="field-btn-row">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const raw = (await invoke<unknown>('check_update')) as Record<string, unknown>;
                          const available = Boolean(raw.updateAvailable ?? raw.update_available ?? false);
                          const current = String(
                            raw.current ?? raw.currentVersion ?? raw.current_version ?? status?.version ?? '',
                          );
                          const latest = String(
                            raw.latest ?? raw.latestVersion ?? raw.latest_version ?? raw.version ?? '',
                          );
                          const text = available
                            ? `可更新：${current || '当前版'} → ${latest || '最新版'}`
                            : `已是最新版${current ? `（${current}）` : ''}`;
                          setUpdateInfo({ text, raw: JSON.stringify(raw, null, 2) });
                          return text;
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      检查更新
                    </button>
                    <input
                      className="inline-input"
                      placeholder="版本号（留空为最新）"
                      value={updateVersion}
                      onChange={(e) => setUpdateVersion(e.target.value)}
                    />
                    <button
                      className="btn primary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm('安装更新会结束活动会话并更新终端共用的 grok。继续？')) return;
                        void run(async () => {
                          const msg = await invoke<string>('install_update', {
                            version: updateVersion.trim() || null,
                          });
                          onSessionEnded();
                          await onRefreshCore();
                          return msg || '更新完成';
                        });
                      }}
                    >
                      {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      安装{updateVersion.trim() ? '指定版本' : '最新版'}
                    </button>
                  </div>
                  <div className="field-btn-row">
                    <span className="field-hint">更新渠道：</span>
                    {(['stable', 'alpha'] as const).map((ch) => (
                      <button
                        key={ch}
                        className="btn"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`切换到 ${ch} 渠道会结束活动会话并更新 grok。继续？`)) return;
                          void run(async () => {
                            const msg = await invoke<string>('switch_update_channel', { channel: ch });
                            onSessionEnded();
                            await onRefreshCore();
                            return msg || `已切换到 ${ch}`;
                          });
                        }}
                      >
                        {ch === 'stable' ? '稳定版 stable' : '尝鲜版 alpha'}
                      </button>
                    ))}
                  </div>
                  {updateInfo && (
                    <div className="update-info">
                      <span className="update-info-line">{updateInfo.text}</span>
                      <details className="update-info-detail">
                        <summary>详情</summary>
                        <pre className="settings-output">{updateInfo.raw}</pre>
                      </details>
                    </div>
                  )}
                </div>
              </>
            )}

            {section === 'mcp' && (
              <>
                <div className="setting-title-row">
                  <strong>
                    <Server size={14} /> MCP 服务器
                  </strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadMcp()}>
                      <RefreshCw size={13} />
                      刷新
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>('mcp_doctor');
                          sectionOutput('mcp', res.output || (res.ok ? 'doctor 通过' : 'doctor 失败'));
                          return res.ok ? 'mcp doctor 完成' : 'mcp doctor 报告了问题';
                        })
                      }
                    >
                      <Stethoscope size={13} />
                      mcp doctor
                    </button>
                  </div>
                </div>
                {mcpItems === null && <p className="muted">加载中…</p>}
                {mcpItems && !mcpItems.length && <p className="muted">没有已配置的 MCP 服务器。</p>}
                {mcpItems?.map((it) => (
                  <div key={it.name} className="list-row">
                    <div className="list-row-meta">
                      <strong>{it.name}</strong>
                      {it.detail && <small>{it.detail}</small>}
                    </div>
                    <span className={`status-dot-label ${it.enabled ? 'online' : ''}`}>
                      {it.enabled ? '已启用' : '已禁用'}
                    </span>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>(it.enabled ? 'mcp_disable' : 'mcp_enable', {
                            name: it.name,
                          });
                          await loadMcp();
                          return cmdNote(res, it.enabled ? '已禁用' : '已启用');
                        })
                      }
                    >
                      {it.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`移除 MCP 服务器「${it.name}」？`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('mcp_remove', { name: it.name });
                          await loadMcp();
                          return cmdNote(res, '已移除');
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="add-form">
                  <strong>添加服务器</strong>
                  <input
                    placeholder="名称"
                    value={mcpName}
                    onChange={(e) => setMcpName(e.target.value)}
                  />
                  <input
                    placeholder="命令或 URL（如 npx 或 http://…）"
                    value={mcpTarget}
                    onChange={(e) => setMcpTarget(e.target.value)}
                  />
                  <input
                    placeholder="参数（空格分隔，可留空）"
                    value={mcpArgs}
                    onChange={(e) => setMcpArgs(e.target.value)}
                  />
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !mcpName.trim()}
                    onClick={() =>
                      void run(async () => {
                        const res = await invoke<CmdResult>('mcp_add', {
                          name: mcpName.trim(),
                          commandOrUrl: mcpTarget.trim() || null,
                          args: mcpArgs.trim() ? mcpArgs.trim().split(/\s+/) : null,
                          transport: null,
                          scope: null,
                          env: null,
                          headers: null,
                        });
                        if (!res.ok) throw new Error(res.output || '添加失败');
                        setMcpName('');
                        setMcpTarget('');
                        setMcpArgs('');
                        await loadMcp();
                        return '已添加';
                      })
                    }
                  >
                    添加
                  </button>
                </div>
              </>
            )}

            {section === 'plugin' && (
              <>
                <div className="setting-title-row">
                  <strong>
                    <Puzzle size={14} /> 插件
                  </strong>
                  <button className="btn" type="button" disabled={busy} onClick={() => void loadPlugins()}>
                    <RefreshCw size={13} />
                    刷新
                  </button>
                </div>
                {plugins === null && <p className="muted">加载中…</p>}
                {plugins && !plugins.length && <p className="muted">没有已安装的插件。</p>}
                {plugins?.map((p) => (
                  <div key={p.name} className="list-row">
                    <div className="list-row-meta">
                      <strong>{p.name}</strong>
                      {p.detail && <small>{p.detail}</small>}
                      {p.name.toLowerCase().includes('superpowers') && (
                        <small className="sp-hint">
                          全局启用会影响所有会话；推荐用顶栏 SP 开关按会话开启
                        </small>
                      )}
                    </div>
                    <span className={`status-dot-label ${p.enabled ? 'online' : ''}`}>
                      {p.enabled ? '已启用' : '已禁用'}
                    </span>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>(p.enabled ? 'plugin_disable' : 'plugin_enable', {
                            name: p.name,
                          });
                          await loadPlugins();
                          return cmdNote(res, p.enabled ? '已禁用' : '已启用');
                        })
                      }
                    >
                      {p.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`卸载插件「${p.name}」？`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('plugin_uninstall', { name: p.name });
                          await loadPlugins();
                          return cmdNote(res, '已卸载');
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="add-form">
                  <strong>安装插件</strong>
                  <input
                    placeholder="git URL 或本地路径"
                    value={pluginSource}
                    onChange={(e) => setPluginSource(e.target.value)}
                  />
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !pluginSource.trim()}
                    onClick={() =>
                      void run(async () => {
                        const res = await invoke<CmdResult>('plugin_install', { source: pluginSource.trim() });
                        if (!res.ok) throw new Error(res.output || '安装失败');
                        setPluginSource('');
                        await loadPlugins();
                        return '已安装';
                      })
                    }
                  >
                    安装
                  </button>
                </div>

                <div className="setting-title-row">
                  <strong>
                    <Store size={14} /> 市场源
                  </strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadMarkets()}>
                      <RefreshCw size={13} />
                      刷新
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>('marketplace_update');
                          await loadMarkets();
                          await loadPlugins();
                          return cmdNote(res, '已全部更新');
                        })
                      }
                    >
                      全部更新
                    </button>
                  </div>
                </div>
                {markets === null && <p className="muted">加载中…</p>}
                {markets && !markets.length && <p className="muted">没有已配置的市场源。</p>}
                {markets?.map((m) => (
                  <div key={m.name} className="list-row">
                    <div className="list-row-meta">
                      <strong>{m.name}</strong>
                      {m.detail && <small>{m.detail}</small>}
                    </div>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`移除市场源「${m.name}」？其下的插件会被一并卸载。`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('marketplace_remove', { source: m.name });
                          await loadMarkets();
                          await loadPlugins();
                          return cmdNote(res, '已移除');
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="add-form">
                  <strong>添加市场源</strong>
                  <input
                    placeholder="源地址（git URL 或路径）"
                    value={marketSource}
                    onChange={(e) => setMarketSource(e.target.value)}
                  />
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !marketSource.trim()}
                    onClick={() =>
                      void run(async () => {
                        const res = await invoke<CmdResult>('marketplace_add', {
                          source: marketSource.trim(),
                        });
                        if (!res.ok) throw new Error(res.output || '添加失败');
                        setMarketSource('');
                        await loadMarkets();
                        return '已添加市场源';
                      })
                    }
                  >
                    添加源
                  </button>
                </div>
              </>
            )}

            {section === 'memory' && (
              <>
                <div className="setting-card">
                  <div>
                    <strong>
                      <Brain size={14} /> 记忆与偏好
                    </strong>
                    <small>注入发生在会话启动时，改动将在下个新会话生效。</small>
                  </div>
                  <div className="pref-row">
                    <div className="pref-meta">
                      <strong>ADHD 简洁风格</strong>
                      <small>每轮会话注入简洁输出规则：下一步优先、少闲聊</small>
                    </div>
                    <Toggle
                      checked={config.adhdAlwaysOn}
                      onChange={(v) => {
                        onSaveConfig({ adhdAlwaysOn: v });
                        noteIn('已保存，将在下个新会话生效');
                      }}
                    />
                  </div>
                  <div className="pref-row">
                    <div className="pref-meta">
                      <strong>自动记忆（热 MEMORY）</strong>
                      <small>启用 grok 原生跨会话记忆（GROK_MEMORY），记住偏好与项目笔记</small>
                    </div>
                    <Toggle
                      checked={config.autoMemory}
                      onChange={(v) => {
                        onSaveConfig({ autoMemory: v });
                        noteIn('已保存，将在下个新会话生效');
                      }}
                    />
                  </div>
                  <div className="pref-row">
                    <div className="pref-meta">
                      <strong>Memo 冷知识库</strong>
                      <small>允许按需只读检索本机 memo-kb 冷知识库，默认关闭</small>
                    </div>
                    <Toggle
                      checked={config.memoKbEnabled}
                      onChange={(v) => {
                        onSaveConfig({ memoKbEnabled: v });
                        noteIn('已保存，将在下个新会话生效');
                      }}
                    />
                  </div>
                </div>

                <div className="setting-title-row">
                  <strong>MEMORY 文件</strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadMemoryFiles()}>
                      <RefreshCw size={13} />
                      刷新
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await invoke('open_memory_folder');
                          return '已打开记忆文件夹';
                        })
                      }
                    >
                      <FolderOpen size={13} />
                      打开记忆文件夹
                    </button>
                  </div>
                </div>
                {memoryFiles === null && <p className="muted">加载中…</p>}
                {memoryFiles && !memoryFiles.length && <p className="muted">未发现记忆文件。</p>}
                {memoryFiles?.map((f) => (
                  <div key={f.path} className="memory-file-block">
                    <button
                      type="button"
                      className={`list-row memory-file-row ${activeMemoryPath === f.path ? 'active' : ''}`}
                      onClick={() => {
                        if (activeMemoryPath === f.path) {
                          setActiveMemoryPath(null);
                          return;
                        }
                        setActiveMemoryPath(f.path);
                        setMemoryContent('');
                        if (f.exists) {
                          invoke<string>('read_memory_file', { path: f.path })
                            .then(setMemoryContent)
                            .catch((e) => noteIn(String(e)));
                        }
                      }}
                    >
                      <div className="list-row-meta">
                        <strong>{f.label}</strong>
                        <small>{f.path}</small>
                      </div>
                      <span className={`scope-badge ${f.scope}`}>
                        {f.scope === 'global' ? '全局' : '工作区'}
                      </span>
                      {f.exists ? (
                        <span className="memory-size">{fmtSize(f.size)}</span>
                      ) : (
                        <span className="memory-missing">尚未创建</span>
                      )}
                    </button>
                    {activeMemoryPath === f.path && (
                      <div className="memory-editor">
                        <textarea
                          value={memoryContent}
                          placeholder={f.exists ? '' : '（文件尚未创建，保存后写入）'}
                          onChange={(e) => setMemoryContent(e.target.value)}
                          rows={8}
                        />
                        <div className="field-btn-row">
                          <button
                            className="btn primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await invoke<MemoryFile>('write_memory_file', {
                                  path: f.path,
                                  content: memoryContent,
                                });
                                await loadMemoryFiles();
                                return '已保存记忆文件';
                              })
                            }
                          >
                            <Save size={13} />
                            保存
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => setActiveMemoryPath(null)}
                          >
                            收起
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                <div className={`setting-card memo-kb ${config.memoKbEnabled ? '' : 'disabled'}`}>
                  <div className="setting-title">
                    <span>
                      <i className={`status-dot ${memoStatus?.available ? 'online' : ''}`} />
                      <strong>Memo 冷知识库</strong>
                    </span>
                    <small>
                      {memoStatus
                        ? memoStatus.detail || (memoStatus.available ? '可用' : '不可用')
                        : '探测中…'}
                    </small>
                  </div>
                  {config.memoKbEnabled ? (
                    <>
                      <div className="field-btn-row">
                        <input
                          className="inline-input"
                          placeholder="输入关键词试搜知识库…"
                          value={memoQuery}
                          onChange={(e) => setMemoQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && memoQuery.trim() && !busy) {
                              setBusy(true);
                              setMemoResult('');
                              invoke<CmdResult>('memo_kb_search', { query: memoQuery.trim() })
                                .then((res) => setMemoResult(res.ok ? res.output || '（无结果）' : '知识库暂不可用'))
                                .catch(() => setMemoResult('知识库暂不可用'))
                                .finally(() => setBusy(false));
                            }
                          }}
                        />
                        <button
                          className="btn"
                          type="button"
                          disabled={busy || !memoQuery.trim()}
                          onClick={() => {
                            setBusy(true);
                            setMemoResult('');
                            invoke<CmdResult>('memo_kb_search', { query: memoQuery.trim() })
                              .then((res) => setMemoResult(res.ok ? res.output || '（无结果）' : '知识库暂不可用'))
                              .catch(() => setMemoResult('知识库暂不可用'))
                              .finally(() => setBusy(false));
                          }}
                        >
                          <Search size={13} />
                          试搜
                        </button>
                      </div>
                      {memoResult && <pre className="settings-output">{memoResult}</pre>}
                    </>
                  ) : (
                    <p className="field-hint">开启「Memo 冷知识库」后可用。</p>
                  )}
                </div>

                <div className="setting-card">
                  <div>
                    <strong>清除记忆</strong>
                    <small>workspace 作用于当前工作区；global 为全局；all 全部清除。</small>
                  </div>
                  <div className="field-btn-row">
                    <select
                      className="inline-select"
                      value={memoryScope}
                      onChange={(e) => setMemoryScope(e.target.value as 'workspace' | 'global' | 'all')}
                    >
                      <option value="workspace">当前工作区</option>
                      <option value="global">全局</option>
                      <option value="all">全部</option>
                    </select>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const label =
                          memoryScope === 'workspace' ? '当前工作区' : memoryScope === 'global' ? '全局' : '全部';
                        if (!window.confirm(`确定清除${label}记忆？此操作不可恢复。`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('memory_clear', {
                            scope: memoryScope,
                            cwd: cwd || null,
                          });
                          return cmdNote(res, '记忆已清除');
                        });
                      }}
                    >
                      <Trash2 size={13} />
                      清除记忆
                    </button>
                  </div>
                </div>

                <div className="setting-title-row">
                  <strong>
                    <Wrench size={14} /> Worktree
                  </strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadWorktrees()}>
                      <RefreshCw size={13} />
                      刷新
                    </button>
                    <input
                      className="inline-input narrow"
                      placeholder="最大年龄，如 7d"
                      value={gcAge}
                      onChange={(e) => setGcAge(e.target.value)}
                    />
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`清理超过 ${gcAge || '指定时间'} 的 worktree？`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_gc', {
                            maxAge: gcAge.trim() || null,
                          });
                          await loadWorktrees();
                          return cmdNote(res, '清理完成');
                        });
                      }}
                    >
                      清理过期
                    </button>
                  </div>
                </div>
                {worktrees === null && <p className="muted">加载中…</p>}
                {worktrees && !worktrees.length && <p className="muted">没有活跃的 worktree。</p>}
                {worktrees?.map((w) => (
                  <div key={w.id} className="list-row">
                    <div className="list-row-meta">
                      <strong>{w.id}</strong>
                      {w.detail && <small>{w.detail}</small>}
                    </div>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title="查看详情"
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_show', { id: w.id });
                          sectionOutput('memory', res.output || '（无输出）');
                          return res.ok ? '已加载详情' : '详情命令报错';
                        })
                      }
                    >
                      <FileText size={13} />
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title="救出该 worktree 的变更到指定目录"
                      onClick={() => {
                        const out = window.prompt(
                          '救出输出目录：',
                          `~/Desktop/grok-salvage-${w.id.slice(0, 8)}`,
                        );
                        if (!out || !out.trim()) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_salvage', {
                            id: w.id,
                            out: out.trim(),
                          });
                          sectionOutput('memory', res.output || '（无输出）');
                          await loadWorktrees();
                          return cmdNote(res, 'salvage 完成');
                        });
                      }}
                    >
                      <Wrench size={13} />
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title="清理该 worktree 的产物"
                      onClick={() => {
                        if (!window.confirm(`清理 worktree「${w.id}」的产物？此操作真删不可恢复。`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_clean_artifacts', { id: w.id });
                          sectionOutput('memory', res.output || '（无输出）');
                          await loadWorktrees();
                          return cmdNote(res, '产物清理完成');
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title="分离（detach）"
                      onClick={() => {
                        if (!window.confirm(`分离 worktree「${w.id}」？`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_detach', { id: w.id });
                          await loadWorktrees();
                          return cmdNote(res, '已分离');
                        });
                      }}
                    >
                      <Unlink size={13} />
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      title="删除"
                      onClick={() => {
                        if (!window.confirm(`删除 worktree「${w.id}」？`)) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_rm', { id: w.id });
                          await loadWorktrees();
                          return cmdNote(res, '已删除');
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="field-btn-row">
                  <span className="field-hint">数据库维护：</span>
                  <select
                    className="inline-select"
                    value={dbCommand}
                    onChange={(e) => setDbCommand(e.target.value as 'stats' | 'rebuild' | 'path')}
                  >
                    <option value="stats">stats（默认）</option>
                    <option value="rebuild">rebuild</option>
                    <option value="path">path</option>
                  </select>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const res = await invoke<CmdResult>('worktree_db', { command: dbCommand });
                        sectionOutput('memory', res.output || '（无输出）');
                        return cmdNote(res, `db ${dbCommand} 完成`);
                      })
                    }
                  >
                    <Database size={13} />
                    执行
                  </button>
                </div>
              </>
            )}

            {section === 'companion' && (
              <>
                <div className="setting-card">
                  <div className="setting-title">
                    <span>
                      <Smartphone size={14} />
                      <strong>手机当第二块屏</strong>
                    </span>
                    <i className={`status-dot ${companion?.enabled ? 'online' : ''}`} />
                  </div>
                  <p className="muted">
                    打开后，同一 Wi-Fi（或 Tailscale）上的手机可以扫码进入已登记的工作区。配对会跨断网和应用重启保留，工具仍在这台 Mac 上执行；只有主动关闭联动或更换令牌才会撤销旧手机。
                  </p>
                  <div className="field-btn-row">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const st = companion?.enabled
                            ? await invoke<CompanionStatus>('companion_disable')
                            : await invoke<CompanionStatus>('companion_enable');
                          setCompanion(st);
                          return st.enabled ? '手机联动已打开' : '手机联动已关闭';
                        })
                      }
                    >
                      {companion?.enabled ? '关闭联动' : '打开联动'}
                    </button>
                    {companion?.enabled && (
                      <button
                        className="btn"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const st = await invoke<CompanionStatus>('companion_rotate_token');
                            setCompanion(st);
                            return '已更换令牌，请重新扫码';
                          })
                        }
                      >
                        更换令牌
                      </button>
                    )}
                  </div>
                </div>
                {companion?.enabled && companion.urls[0] && (
                  <div className="setting-card">
                    <div className="setting-title">
                      <strong>用手机相机扫码</strong>
                    </div>
                    {companion.qrSvg ? (
                      <div
                        className="companion-qr"
                        dangerouslySetInnerHTML={{ __html: companion.qrSvg }}
                      />
                    ) : null}
                    <p className="muted" style={{ wordBreak: 'break-all' }}>
                      {companion.urls[0]}
                    </p>
                    {companion.urls.length > 1 && (
                      <p className="muted">其它地址：{companion.urls.slice(1).join(' · ')}</p>
                    )}
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(companion.urls[0]).then(
                          () => flash('已复制链接'),
                          () => flash('复制失败'),
                        );
                      }}
                    >
                      复制链接
                    </button>
                  </div>
                )}
              </>
            )}

            {section === 'theme' && (
              <div className="field">
                <span>外观主题（同步原生窗口）</span>
                <div className="theme-picker">
                  {(
                    [
                      { id: 'system', label: '系统', icon: <Monitor size={15} /> },
                      { id: 'light', label: '浅色', icon: <Sun size={15} /> },
                      { id: 'dark', label: '深色', icon: <Moon size={15} /> },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={config.theme === t.id ? 'active' : ''}
                      onClick={() => onSaveConfig({ theme: t.id })}
                    >
                      {t.icon}
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {section === 'diagnostics' && (
              <>
                <div className="field-btn-row">
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const res = await invoke<CmdResult>('doctor');
                        sectionOutput('diagnostics', res.output || (res.ok ? 'doctor 通过' : 'doctor 失败'));
                        return res.ok ? 'doctor 完成' : 'doctor 报告了问题';
                      })
                    }
                  >
                    <Stethoscope size={14} />
                    运行 doctor
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !cwd}
                    title={cwd ? '' : '需要先选择工作区'}
                    onClick={() =>
                      void run(async () => {
                        const raw = await invoke<unknown>('extension_status', { cwd });
                        sectionOutput('diagnostics', JSON.stringify(raw, null, 2));
                        return 'inspect --json 完成';
                      })
                    }
                  >
                    <Stethoscope size={14} />
                    inspect --json
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const raw = await invoke<CoreStatus>('core_status');
                        sectionOutput('diagnostics', JSON.stringify(raw, null, 2));
                        return 'core_status 完成';
                      })
                    }
                  >
                    <RefreshCw size={14} />
                    core_status
                  </button>
                </div>

                <div className="setting-card">
                  <div className="setting-title">
                    <span>
                      <HardDrive size={14} />
                      <strong>磁盘占用</strong>
                    </span>
                    {diskUsage?.grokHome ? <small>{diskUsage.grokHome}</small> : null}
                  </div>
                  {diskUsage === null ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const raw = (await invoke<unknown>('disk_usage')) as Record<string, unknown>;
                          const dirs = Array.isArray(raw.top_level_dirs) ? raw.top_level_dirs : [];
                          setDiskUsage({
                            grokHome: String(raw.grok_home ?? ''),
                            totalBytes: Number(raw.total_bytes ?? 0),
                            volumeAvailableBytes:
                              raw.volume_available_bytes !== undefined
                                ? Number(raw.volume_available_bytes)
                                : undefined,
                            topDirs: dirs
                              .map((d): { name: string; bytes: number } | null => {
                                if (!d || typeof d !== 'object') return null;
                                const o = d as Record<string, unknown>;
                                return {
                                  name: String(o.name ?? o.path ?? o.dir ?? ''),
                                  bytes: Number(o.bytes ?? o.size ?? 0),
                                };
                              })
                              .filter((x): x is { name: string; bytes: number } => !!x),
                          });
                          return '磁盘占用已加载';
                        })
                      }
                    >
                      统计磁盘占用
                    </button>
                  ) : (
                    <>
                      <div className="usage-stat-row">
                        <span className="usage-stat">
                          <small>~/.grok 总占用</small>
                          <strong>{fmtSize(diskUsage.totalBytes)}</strong>
                        </span>
                        {diskUsage.volumeAvailableBytes !== undefined && (
                          <span className="usage-stat">
                            <small>卷剩余</small>
                            <strong>{fmtSize(diskUsage.volumeAvailableBytes)}</strong>
                          </span>
                        )}
                      </div>
                      {diskUsage.topDirs.length > 0 && (
                        <div className="usage-top">
                          <div className="usage-sub-title">占用最高的目录</div>
                          {diskUsage.topDirs.slice(0, 5).map((d) => (
                            <div key={d.name} className="usage-top-row">
                              <span className="usage-top-title" title={d.name}>
                                {d.name}
                              </span>
                              <span className="usage-top-nums">{fmtSize(d.bytes)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <p className="field-hint">MCP 诊断请使用「MCP 服务器」分区的 mcp doctor。</p>
              </>
            )}

            {output && output.section === section && (
              <pre className="settings-output">{output.text}</pre>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
