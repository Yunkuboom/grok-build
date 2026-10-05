import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, CmdResult, CompanionStatus, CoreStatus, MemoryFile, MemoStatus } from '../types';
import { EFFORT_FALLBACK, permissionModes } from '../types';
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
import { t } from '../i18n';

type Section = 'accountModel' | 'cli' | 'companion' | 'mcp' | 'plugin' | 'memory' | 'theme' | 'diagnostics';

function sectionList(): Array<{ id: Section; label: string }> {
  return [
  { id: 'accountModel', label: t('账号与模型', 'Account and model') },
  { id: 'cli', label: t('CLI 内核', 'CLI core') },
  { id: 'companion', label: t('手机联动', 'Phone companion') },
  { id: 'mcp', label: t('MCP 服务器', 'MCP servers') },
  { id: 'plugin', label: t('插件', 'Plugins') },
  { id: 'memory', label: t('记忆与 Worktree', 'Memory and worktrees') },
  { id: 'theme', label: t('主题与语言', 'Theme and language') },
  { id: 'diagnostics', label: t('诊断', 'Diagnostics') },
  ];
}

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
    const name = String(it.name ?? it.id ?? t('未命名', 'Untitled'));
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
    const name = String(it.name ?? it.id ?? t('未命名', 'Untitled'));
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
            name: String(it.name ?? it.source ?? it.url ?? it.id ?? t('未命名源', 'Unnamed source')),
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

  const cmdNote = (res: CmdResult, okText: string) => (res.ok ? okText : res.output || t('命令失败', 'Command failed'));

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('设置', 'Settings')}>
        <div className="modal-header">
          <strong>{t('设置', 'Settings')}</strong>
          <button className="icon-btn" type="button" title={t('关闭 (Esc)', 'Close (Esc)')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            {sectionList().map((s) => (
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
                      <strong>{t('Grok 官方账户', 'Grok account')}</strong>
                    </span>
                    <small>{status?.authMessage || (status ? '' : t('检测中…', 'Checking…'))}</small>
                  </div>
                  <div className="field-btn-row">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await invoke('launch_login');
                          return t('已在终端打开 grok login --oauth', 'Opened grok login --oauth in Terminal');
                        })
                      }
                    >
                      <LogIn size={14} />
                      {t('在终端登录', 'Log in via Terminal')}</button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await invoke('launch_device_login');
                          return t('已在终端打开设备码登录', 'Opened device-code login in Terminal');
                        })
                      }
                    >
                      <LogIn size={14} />
                      {t('设备码登录', 'Device-code login')}</button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy || !status?.authenticated}
                      onClick={() => {
                        if (!window.confirm(t('退出登录将结束活动会话，并影响终端共用的 grok。继续？', 'Logging out ends the active session and affects the grok CLI shared with Terminal. Continue?'))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('logout');
                          onSessionEnded();
                          await onRefreshCore();
                          return cmdNote(res, t('已退出登录', 'Logged out'));
                        });
                      }}
                    >
                      <LogOut size={14} />
                      {t('退出登录', 'Log out')}</button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await onRefreshCore();
                          return t('状态已刷新', 'Status refreshed');
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      {t('刷新状态', 'Refresh status')}</button>
                  </div>
                </div>
                <label className="field">
                  <span>
                    <Cpu size={13} /> {t('默认模型（新会话生效）', 'Default model (applies to new sessions)')}
                  </span>
                  <select value={config.model} onChange={(e) => onSaveConfig({ model: e.target.value })}>
                    <option value="">{t('跟随 CLI 默认', 'Follow the CLI default')}</option>
                    {status?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.isDefault ? t('（默认）', '(default)') : ''}
                      </option>
                    ))}
                    {config.model && !status?.models.some((m) => m.id === config.model) && (
                      <option value={config.model}>{config.model}</option>
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>
                    <Brain size={13} /> {t('推理强度（新会话生效）', 'Reasoning effort (applies to new sessions)')}
                  </span>
                  <select value={config.effort} onChange={(e) => onSaveConfig({ effort: e.target.value })}>
                    <option value="">{t('跟随 CLI 默认', 'Follow the CLI default')}</option>
                    {EFFORT_FALLBACK.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>
                    <Shield size={13} /> {t('默认权限模式（新会话生效）', 'Default permission mode (applies to new sessions)')}
                  </span>
                  <select
                    value={config.permissionMode}
                    onChange={(e) => onSaveConfig({ permissionMode: e.target.value })}
                  >
                    {permissionModes().map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">{t('会话进行中可在输入框工具栏临时切换模型、强度与权限模式。', 'While a session is running, switch model, effort, and permission mode from the composer toolbar.')}</p>
              </>
            )}

            {section === 'cli' && (
              <>
                <div className="field">
                  <span>{t('CLI 路径', 'CLI path')}</span>
                  <code className="static-code">{status?.cliPath || t('检测中…', 'Checking…')}</code>
                  <small>{t('与终端共用 ~/.grok 登录、会话及配置。', 'Shares the ~/.grok login, sessions, and config with the terminal.')}</small>
                </div>
                <div className="field">
                  <span>{t('当前版本', 'Current version')}</span>
                  <code className="static-code">{status?.version || t('检测中…', 'Checking…')}</code>
                </div>
                <div className="setting-card">
                  <div>
                    <strong>{t('更新内核', 'Update CLI')}</strong>
                    <small>{t('更新会影响终端共用的 grok，并结束本应用中的活动会话。', 'Updates the grok CLI shared with Terminal and ends the active session in this app.')}</small>
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
                            ? t(`可更新：${current || '当前版'} → ${latest || t('最新版', 'Latest')}`, `Update available: ${current || 'current'} → ${latest || 'latest'}`)
                            : t(`已是最新版${current ? `（${current}）` : ''}`, `Already up to date${current ? ` (${current})` : ''}`);
                          setUpdateInfo({ text, raw: JSON.stringify(raw, null, 2) });
                          return text;
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      {t('检查更新', 'Check for updates')}
                    </button>
                    <input
                      className="inline-input"
                      placeholder={t('版本号（留空为最新）', 'Version (empty means latest)')}
                      value={updateVersion}
                      onChange={(e) => setUpdateVersion(e.target.value)}
                    />
                    <button
                      className="btn primary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(t('安装更新会结束活动会话并更新终端共用的 grok。继续？', 'Installing an update ends the active session and updates the grok CLI shared with Terminal. Continue?'))) return;
                        void run(async () => {
                          const msg = await invoke<string>('install_update', {
                            version: updateVersion.trim() || null,
                          });
                          onSessionEnded();
                          await onRefreshCore();
                          return msg || t('更新完成', 'Update finished');
                        });
                      }}
                    >
                      {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      {updateVersion.trim() ? t('安装指定版本', 'Install specific version') : t('安装最新版', 'Install latest')}
                    </button>
                  </div>
                  <div className="field-btn-row">
                    <span className="field-hint">{t('更新渠道：', 'Update channel:')}</span>
                    {(['stable', 'alpha'] as const).map((ch) => (
                      <button
                        key={ch}
                        className="btn"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(t(`切换到 ${ch} 渠道会结束活动会话并更新 grok。继续？`, `Switching to the ${ch} channel ends the active session and updates grok. Continue?`))) return;
                          void run(async () => {
                            const msg = await invoke<string>('switch_update_channel', { channel: ch });
                            onSessionEnded();
                            await onRefreshCore();
                            return msg || t(`已切换到 ${ch}`, `Switched to ${ch}`);
                          });
                        }}
                      >
                        {ch === 'stable' ? t('稳定版 stable', 'Stable channel') : t('尝鲜版 alpha', 'Alpha channel')}
                      </button>
                    ))}
                  </div>
                  {updateInfo && (
                    <div className="update-info">
                      <span className="update-info-line">{updateInfo.text}</span>
                      <details className="update-info-detail">
                        <summary>{t('详情', 'Details')}</summary>
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
                    <Server size={14} /> {t('MCP 服务器', 'MCP servers')}</strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadMcp()}>
                      <RefreshCw size={13} />
                      {t('刷新', 'Refresh')}</button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>('mcp_doctor');
                          sectionOutput('mcp', res.output || (res.ok ? t('doctor 通过', 'doctor passed') : t('doctor 失败', 'doctor failed')));
                          return res.ok ? t('mcp doctor 完成', 'mcp doctor finished') : t('mcp doctor 报告了问题', 'mcp doctor reported problems');
                        })
                      }
                    >
                      <Stethoscope size={13} />
                      mcp doctor
                    </button>
                  </div>
                </div>
                {mcpItems === null && <p className="muted">{t('加载中…', 'Loading…')}</p>}
                {mcpItems && !mcpItems.length && <p className="muted">{t('没有已配置的 MCP 服务器。', 'No MCP servers configured.')}</p>}
                {mcpItems?.map((it) => (
                  <div key={it.name} className="list-row">
                    <div className="list-row-meta">
                      <strong>{it.name}</strong>
                      {it.detail && <small>{it.detail}</small>}
                    </div>
                    <span className={`status-dot-label ${it.enabled ? 'online' : ''}`}>
                      {it.enabled ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}
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
                          return cmdNote(res, it.enabled ? t('已禁用', 'Disabled') : t('已启用', 'Enabled'));
                        })
                      }
                    >
                      {it.enabled ? t('禁用', 'Disable') : t('启用', 'Enable')}
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(t(`移除 MCP 服务器「${it.name}」？`, `Remove MCP server “${it.name}”?`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('mcp_remove', { name: it.name });
                          await loadMcp();
                          return cmdNote(res, t('已移除', 'Removed'));
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="add-form">
                  <strong>{t('添加服务器', 'Add server')}</strong>
                  <input
                    placeholder={t('名称', 'Name')}
                    value={mcpName}
                    onChange={(e) => setMcpName(e.target.value)}
                  />
                  <input
                    placeholder={t('命令或 URL（如 npx 或 http://…）', 'Command or URL (for example npx or http://…)')}
                    value={mcpTarget}
                    onChange={(e) => setMcpTarget(e.target.value)}
                  />
                  <input
                    placeholder={t('参数（空格分隔，可留空）', 'Arguments (space-separated, optional)')}
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
                        if (!res.ok) throw new Error(res.output || t('添加失败', 'Could not add'));
                        setMcpName('');
                        setMcpTarget('');
                        setMcpArgs('');
                        await loadMcp();
                        return t('已添加', 'Added');
                      })
                    }
                  >
                    {t('添加', 'Add')}
                  </button>
                </div>
              </>
            )}

            {section === 'plugin' && (
              <>
                <div className="setting-title-row">
                  <strong>
                    <Puzzle size={14} /> {t('插件', 'Plugins')}</strong>
                  <button className="btn" type="button" disabled={busy} onClick={() => void loadPlugins()}>
                    <RefreshCw size={13} />
                    {t('刷新', 'Refresh')}</button>
                </div>
                {plugins === null && <p className="muted">{t('加载中…', 'Loading…')}</p>}
                {plugins && !plugins.length && <p className="muted">{t('没有已安装的插件。', 'No plugins installed.')}</p>}
                {plugins?.map((p) => (
                  <div key={p.name} className="list-row">
                    <div className="list-row-meta">
                      <strong>{p.name}</strong>
                      {p.detail && <small>{p.detail}</small>}
                      {p.name.toLowerCase().includes('superpowers') && (
                        <small className="sp-hint">
                          {t('全局启用会影响所有会话；推荐用顶栏 SP 开关按会话开启', 'Turning this on globally affects every session. Prefer the SP switch in the top bar for one session.')}
                        </small>
                      )}
                    </div>
                    <span className={`status-dot-label ${p.enabled ? 'online' : ''}`}>
                      {p.enabled ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}
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
                          return cmdNote(res, p.enabled ? t('已禁用', 'Disabled') : t('已启用', 'Enabled'));
                        })
                      }
                    >
                      {p.enabled ? t('禁用', 'Disable') : t('启用', 'Enable')}
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(t(`卸载插件「${p.name}」？`, `Uninstall plugin “${p.name}”?`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('plugin_uninstall', { name: p.name });
                          await loadPlugins();
                          return cmdNote(res, t('已卸载', 'Uninstalled'));
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="add-form">
                  <strong>{t('安装插件', 'Install plugin')}</strong>
                  <input
                    placeholder={t('git URL 或本地路径', 'Git URL or local path')}
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
                        if (!res.ok) throw new Error(res.output || t('安装失败', 'Install failed'));
                        setPluginSource('');
                        await loadPlugins();
                        return t('已安装', 'Installed');
                      })
                    }
                  >
                    {t('安装', 'Install')}
                  </button>
                </div>

                <div className="setting-title-row">
                  <strong>
                    <Store size={14} /> {t('市场源', 'Marketplaces')}</strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadMarkets()}>
                      <RefreshCw size={13} />
                      {t('刷新', 'Refresh')}</button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>('marketplace_update');
                          await loadMarkets();
                          await loadPlugins();
                          return cmdNote(res, t('已全部更新', 'Everything is up to date'));
                        })
                      }
                    >
                      {t('全部更新', 'Update all')}
                    </button>
                  </div>
                </div>
                {markets === null && <p className="muted">{t('加载中…', 'Loading…')}</p>}
                {markets && !markets.length && <p className="muted">{t('没有已配置的市场源。', 'No marketplaces configured.')}</p>}
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
                        if (!window.confirm(t(`移除市场源「${m.name}」？其下的插件会被一并卸载。`, `Remove marketplace “${m.name}”? Its plugins will be uninstalled too.`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('marketplace_remove', { source: m.name });
                          await loadMarkets();
                          await loadPlugins();
                          return cmdNote(res, t('已移除', 'Removed'));
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="add-form">
                  <strong>{t('添加市场源', 'Add marketplace')}</strong>
                  <input
                    placeholder={t('源地址（git URL 或路径）', 'Source (Git URL or path)')}
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
                        if (!res.ok) throw new Error(res.output || t('添加失败', 'Could not add'));
                        setMarketSource('');
                        await loadMarkets();
                        return t('已添加市场源', 'Marketplace added');
                      })
                    }
                  >
                    {t('添加源', 'Add source')}
                  </button>
                </div>
              </>
            )}

            {section === 'memory' && (
              <>
                <div className="setting-card">
                  <div>
                    <strong>
                      <Brain size={14} /> {t('记忆与偏好', 'Memory and preferences')}
                    </strong>
                    <small>{t('注入发生在会话启动时，改动将在下个新会话生效。', 'Rules are injected when a session starts. Changes apply to the next new session.')}</small>
                  </div>
                  <div className="pref-row">
                    <div className="pref-meta">
                      <strong>{t('ADHD 简洁风格', 'ADHD concise style')}</strong>
                      <small>{t('每轮会话注入简洁输出规则：下一步优先、少闲聊', 'Inject concise-output rules into each new session')}</small>
                    </div>
                    <Toggle
                      checked={config.adhdAlwaysOn}
                      onChange={(v) => {
                        onSaveConfig({ adhdAlwaysOn: v });
                        noteIn(t('已保存，将在下个新会话生效', 'Saved. Applies to the next new session'));
                      }}
                    />
                  </div>
                  <div className="pref-row">
                    <div className="pref-meta">
                      <strong>{t('自动记忆（热 MEMORY）', 'Auto memory (hot MEMORY)')}</strong>
                      <small>{t('启用 grok 原生跨会话记忆（GROK_MEMORY），记住偏好与项目笔记', "Use grok's cross-session memory (GROK_MEMORY) for preferences and project notes")}</small>
                    </div>
                    <Toggle
                      checked={config.autoMemory}
                      onChange={(v) => {
                        onSaveConfig({ autoMemory: v });
                        noteIn(t('已保存，将在下个新会话生效', 'Saved. Applies to the next new session'));
                      }}
                    />
                  </div>
                  <div className="pref-row">
                    <div className="pref-meta">
                      <strong>{t('Memo 冷知识库', 'Memo knowledge base')}</strong>
                      <small>{t('允许按需只读检索本机 memo-kb 冷知识库，默认关闭', 'Allow on-demand read-only memo-kb search. Off by default')}</small>
                    </div>
                    <Toggle
                      checked={config.memoKbEnabled}
                      onChange={(v) => {
                        onSaveConfig({ memoKbEnabled: v });
                        noteIn(t('已保存，将在下个新会话生效', 'Saved. Applies to the next new session'));
                      }}
                    />
                  </div>
                </div>

                <div className="setting-title-row">
                  <strong>{t('MEMORY 文件', 'MEMORY files')}</strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadMemoryFiles()}>
                      <RefreshCw size={13} />
                      {t('刷新', 'Refresh')}</button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await invoke('open_memory_folder');
                          return t('已打开记忆文件夹', 'Opened the memory folder');
                        })
                      }
                    >
                      <FolderOpen size={13} />
                      {t('打开记忆文件夹', 'Open memory folder')}
                    </button>
                  </div>
                </div>
                {memoryFiles === null && <p className="muted">{t('加载中…', 'Loading…')}</p>}
                {memoryFiles && !memoryFiles.length && <p className="muted">{t('未发现记忆文件。', 'No memory files yet.')}</p>}
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
                        {f.scope === 'global' ? t('全局', 'Global') : t('工作区', 'Workspace')}
                      </span>
                      {f.exists ? (
                        <span className="memory-size">{fmtSize(f.size)}</span>
                      ) : (
                        <span className="memory-missing">{t('尚未创建', 'Not created yet')}</span>
                      )}
                    </button>
                    {activeMemoryPath === f.path && (
                      <div className="memory-editor">
                        <textarea
                          value={memoryContent}
                          placeholder={f.exists ? '' : t('（文件尚未创建，保存后写入）', '(file does not exist yet; saving will create it)')}
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
                                return t('已保存记忆文件', 'Memory file saved');
                              })
                            }
                          >
                            <Save size={13} />
                            {t('保存', 'Save')}</button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => setActiveMemoryPath(null)}
                          >
                            {t('收起', 'Collapse')}
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
                      <strong>{t('Memo 冷知识库', 'Memo knowledge base')}</strong>
                    </span>
                    <small>
                      {memoStatus
                        ? memoStatus.detail || (memoStatus.available ? t('可用', 'Available') : t('不可用', 'Unavailable'))
                        : t('探测中…', 'Checking…')}
                    </small>
                  </div>
                  {config.memoKbEnabled ? (
                    <>
                      <div className="field-btn-row">
                        <input
                          className="inline-input"
                          placeholder={t('输入关键词试搜知识库…', 'Try a knowledge-base search…')}
                          value={memoQuery}
                          onChange={(e) => setMemoQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && memoQuery.trim() && !busy) {
                              setBusy(true);
                              setMemoResult('');
                              invoke<CmdResult>('memo_kb_search', { query: memoQuery.trim() })
                                .then((res) => setMemoResult(res.ok ? res.output || t('（无结果）', '(no results)') : t('知识库暂不可用', 'Knowledge base unavailable')))
                                .catch(() => setMemoResult(t('知识库暂不可用', 'Knowledge base unavailable')))
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
                              .then((res) => setMemoResult(res.ok ? res.output || t('（无结果）', '(no results)') : t('知识库暂不可用', 'Knowledge base unavailable')))
                              .catch(() => setMemoResult(t('知识库暂不可用', 'Knowledge base unavailable')))
                              .finally(() => setBusy(false));
                          }}
                        >
                          <Search size={13} />
                          {t('试搜', 'Try search')}
                        </button>
                      </div>
                      {memoResult && <pre className="settings-output">{memoResult}</pre>}
                    </>
                  ) : (
                    <p className="field-hint">{t('开启「Memo 冷知识库」后可用。', 'Available after Memo knowledge base is turned on.')}</p>
                  )}
                </div>

                <div className="setting-card">
                  <div>
                    <strong>{t('清除记忆', 'Clear memory')}</strong>
                    <small>{t('workspace 作用于当前工作区；global 为全局；all 全部清除。', 'workspace clears the current project; global clears the global memory; all clears both.')}</small>
                  </div>
                  <div className="field-btn-row">
                    <select
                      className="inline-select"
                      value={memoryScope}
                      onChange={(e) => setMemoryScope(e.target.value as 'workspace' | 'global' | 'all')}
                    >
                      <option value="workspace">{t('当前工作区', 'Current workspace')}</option>
                      <option value="global">{t('全局', 'Global')}</option>
                      <option value="all">{t('全部', 'All')}</option>
                    </select>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const label =
                          memoryScope === 'workspace' ? t('当前工作区', 'Current workspace') : memoryScope === 'global' ? t('全局', 'Global') : t('全部', 'All');
                        if (!window.confirm(t(`确定清除${label}记忆？此操作不可恢复。`, `Clear ${label} memory? This cannot be undone.`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('memory_clear', {
                            scope: memoryScope,
                            cwd: cwd || null,
                          });
                          return cmdNote(res, t('记忆已清除', 'Memory cleared'));
                        });
                      }}
                    >
                      <Trash2 size={13} />
                      {t('清除记忆', 'Clear memory')}</button>
                  </div>
                </div>

                <div className="setting-title-row">
                  <strong>
                    <Wrench size={14} /> Worktree
                  </strong>
                  <div className="field-btn-row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void loadWorktrees()}>
                      <RefreshCw size={13} />
                      {t('刷新', 'Refresh')}</button>
                    <input
                      className="inline-input narrow"
                      placeholder={t('最大年龄，如 7d', 'Max age, for example 7d')}
                      value={gcAge}
                      onChange={(e) => setGcAge(e.target.value)}
                    />
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(t(`清理超过 ${gcAge || '指定时间'} 的 worktree？`, `Clean worktrees older than ${gcAge || 'the given age'}?`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_gc', {
                            maxAge: gcAge.trim() || null,
                          });
                          await loadWorktrees();
                          return cmdNote(res, t('清理完成', 'Cleanup finished'));
                        });
                      }}
                    >
                      {t('清理过期', 'Clean expired')}
                    </button>
                  </div>
                </div>
                {worktrees === null && <p className="muted">{t('加载中…', 'Loading…')}</p>}
                {worktrees && !worktrees.length && <p className="muted">{t('没有活跃的 worktree。', 'No active worktrees.')}</p>}
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
                      title={t('查看详情', 'View details')}
                      onClick={() =>
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_show', { id: w.id });
                          sectionOutput('memory', res.output || t('（无输出）', '(no output)'));
                          return res.ok ? t('已加载详情', 'Details loaded') : t('详情命令报错', 'The details command failed');
                        })
                      }
                    >
                      <FileText size={13} />
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title={t('救出该 worktree 的变更到指定目录', "Salvage this worktree's changes into a directory")}
                      onClick={() => {
                        const out = window.prompt(
                          t('救出输出目录：', 'Salvage output directory:'),
                          `~/Desktop/grok-salvage-${w.id.slice(0, 8)}`,
                        );
                        if (!out || !out.trim()) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_salvage', {
                            id: w.id,
                            out: out.trim(),
                          });
                          sectionOutput('memory', res.output || t('（无输出）', '(no output)'));
                          await loadWorktrees();
                          return cmdNote(res, t('salvage 完成', 'salvage finished'));
                        });
                      }}
                    >
                      <Wrench size={13} />
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title={t('清理该 worktree 的产物', "Clean this worktree's artifacts")}
                      onClick={() => {
                        if (!window.confirm(t(`清理 worktree「${w.id}」的产物？此操作真删不可恢复。`, `Clean artifacts in worktree “${w.id}”? This permanently deletes them.`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_clean_artifacts', { id: w.id });
                          sectionOutput('memory', res.output || t('（无输出）', '(no output)'));
                          await loadWorktrees();
                          return cmdNote(res, t('产物清理完成', 'Artifact cleanup finished'));
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      title={t('分离（detach）', 'Detach')}
                      onClick={() => {
                        if (!window.confirm(t(`分离 worktree「${w.id}」？`, `Detach worktree “${w.id}”?`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_detach', { id: w.id });
                          await loadWorktrees();
                          return cmdNote(res, t('已分离', 'Detached'));
                        });
                      }}
                    >
                      <Unlink size={13} />
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      title={t('删除', 'Delete')}
                      onClick={() => {
                        if (!window.confirm(t(`删除 worktree「${w.id}」？`, `Delete worktree “${w.id}”?`))) return;
                        void run(async () => {
                          const res = await invoke<CmdResult>('worktree_rm', { id: w.id });
                          await loadWorktrees();
                          return cmdNote(res, t('已删除', 'Deleted'));
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="field-btn-row">
                  <span className="field-hint">{t('数据库维护：', 'Database maintenance:')}</span>
                  <select
                    className="inline-select"
                    value={dbCommand}
                    onChange={(e) => setDbCommand(e.target.value as 'stats' | 'rebuild' | 'path')}
                  >
                    <option value="stats">{t('stats（默认）', 'stats (default)')}</option>
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
                        sectionOutput('memory', res.output || t('（无输出）', '(no output)'));
                        return cmdNote(res, t(`db ${dbCommand} 完成`, `db ${dbCommand} finished`));
                      })
                    }
                  >
                    <Database size={13} />
                    {t('执行', 'Run')}
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
                      <strong>{t('手机当第二块屏', 'Use your phone as a second screen')}</strong>
                    </span>
                    <i className={`status-dot ${companion?.enabled ? 'online' : ''}`} />
                  </div>
                  <p className="muted">
                    {t('打开后，同一 Wi-Fi（或 Tailscale）上的手机可以扫码进入已登记的工作区。配对会跨断网和应用重启保留，工具仍在这台 Mac 上执行；只有主动关闭联动或更换令牌才会撤销旧手机。', 'When this is on, a phone on the same Wi-Fi or Tailscale network can scan the code and open registered workspaces. Pairing survives disconnects and app restarts. Tools still run on this Mac. Only turning the companion off or rotating the token disconnects old phones.')}
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
                          return st.enabled ? t('手机联动已打开', 'Phone companion is on') : t('手机联动已关闭', 'Phone companion is off');
                        })
                      }
                    >
                      {companion?.enabled ? t('关闭联动', 'Turn off companion') : t('打开联动', 'Turn on companion')}
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
                            return t('已更换令牌，请重新扫码', 'Token rotated. Scan the new code');
                          })
                        }
                      >
                        {t('更换令牌', 'Rotate token')}
                      </button>
                    )}
                  </div>
                </div>
                {companion?.enabled && companion.urls[0] && (
                  <div className="setting-card">
                    <div className="setting-title">
                      <strong>{t('用手机相机扫码', 'Scan with the phone camera')}</strong>
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
                      <p className="muted">{t('其它地址：', 'Other addresses: ')}{companion.urls.slice(1).join(' · ')}</p>
                    )}
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(companion.urls[0]).then(
                          () => flash(t('已复制链接', 'Link copied')),
                          () => flash(t('复制失败', 'Copy failed')),
                        );
                      }}
                    >
                      {t('复制链接', 'Copy link')}</button>
                  </div>
                )}
              </>
            )}

            {section === 'theme' && (
              <>
                <div className="field">
                  <span>{t('界面语言', 'Language')}</span>
                  <div className="theme-picker">
                    {(
                      [
                        { id: 'system', label: t('跟随系统', 'System') },
                        { id: 'zh', label: '中文' },
                        { id: 'en', label: 'English' },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={(config.locale || 'system') === item.id ? 'active' : ''}
                        onClick={() => onSaveConfig({ locale: item.id })}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <p className="field-hint">
                    {t(
                      '默认跟随系统语言。手机联动使用同一个选择；选「跟随系统」时，电脑和手机各自按自己的系统语言显示。',
                      'Defaults to the system language. The phone companion uses the same choice. System lets each device follow its own language.',
                    )}
                  </p>
                </div>
                <div className="field">
                  <span>{t('外观主题（同步原生窗口）', 'Appearance (also updates the window)')}</span>
                  <div className="theme-picker">
                    {(
                      [
                        { id: 'system', label: t('系统', 'System'), icon: <Monitor size={15} /> },
                        { id: 'light', label: t('浅色', 'Light'), icon: <Sun size={15} /> },
                        { id: 'dark', label: t('深色', 'Dark'), icon: <Moon size={15} /> },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={config.theme === item.id ? 'active' : ''}
                        onClick={() => onSaveConfig({ theme: item.id })}
                      >
                        {item.icon}
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
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
                        sectionOutput('diagnostics', res.output || (res.ok ? t('doctor 通过', 'doctor passed') : t('doctor 失败', 'doctor failed')));
                        return res.ok ? t('doctor 完成', 'doctor finished') : t('doctor 报告了问题', 'doctor reported problems');
                      })
                    }
                  >
                    <Stethoscope size={14} />
                    {t('运行 doctor', 'Run doctor')}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !cwd}
                    title={cwd ? '' : t('需要先选择工作区', 'Choose a workspace first')}
                    onClick={() =>
                      void run(async () => {
                        const raw = await invoke<unknown>('extension_status', { cwd });
                        sectionOutput('diagnostics', JSON.stringify(raw, null, 2));
                        return t('inspect --json 完成', 'inspect --json finished');
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
                        return t('core_status 完成', 'core_status finished');
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
                      <strong>{t('磁盘占用', 'Disk usage')}</strong>
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
                          return t('磁盘占用已加载', 'Disk usage loaded');
                        })
                      }
                    >
                      {t('统计磁盘占用', 'Measure disk usage')}
                    </button>
                  ) : (
                    <>
                      <div className="usage-stat-row">
                        <span className="usage-stat">
                          <small>{t('~/.grok 总占用', 'Total ~/.grok usage')}</small>
                          <strong>{fmtSize(diskUsage.totalBytes)}</strong>
                        </span>
                        {diskUsage.volumeAvailableBytes !== undefined && (
                          <span className="usage-stat">
                            <small>{t('卷剩余', 'Volume free')}</small>
                            <strong>{fmtSize(diskUsage.volumeAvailableBytes)}</strong>
                          </span>
                        )}
                      </div>
                      {diskUsage.topDirs.length > 0 && (
                        <div className="usage-top">
                          <div className="usage-sub-title">{t('占用最高的目录', 'Largest directories')}</div>
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
                <p className="field-hint">{t('MCP 诊断请使用「MCP 服务器」分区的 mcp doctor。', 'For MCP checks, use mcp doctor in the MCP servers section.')}</p>
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
