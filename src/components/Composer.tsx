import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke, isCompanion, isTauri } from '../bridge';
import type {
  Attachment,
  AvailableCommand,
  ConfigOptionValue,
  ModelInfo,
  PermissionModeMeta,
  SessionModeInfo,
  TreeNode,
} from '../types';
import { permissionModes } from '../types';
import {
  ArrowUp,
  AtSign,
  BookmarkPlus,
  Brain,
  Check,
  ChevronDown,
  Cpu,
  File,
  FileCode2,
  FileText,
  FolderOpen,
  Loader2,
  Paperclip,
  Shield,
  Square,
  TerminalSquare,
  X,
} from '../icons';
import { t } from '../i18n';

interface Props {
  value: string;
  busy: boolean;
  cwd: string;
  commands: AvailableCommand[];
  attachments: Attachment[];
  dragOver: boolean;
  onAddAttachments: (paths: string[]) => void;
  onRemoveAttachment: (path: string) => void;
  floating?: boolean;
  placeholder?: string;
  mode: string;
  modeBusy?: boolean;
  availableModes: SessionModeInfo[];
  model: string;
  models: ModelInfo[];
  effort: string;
  effortOptions: ConfigOptionValue[];
  sessionActive: boolean;
  pendingRequests?: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onModeChange: (modeId: string) => void;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: string) => void;
  onRememberNote?: () => void;
  rememberState?: 'idle' | 'saving' | 'done';
  rememberDisabled?: boolean;
  allowAttachments?: boolean;
  focusRequest?: number;
}

type OpenMenu = 'mode' | 'model' | 'effort' | null;

type FileItem = { path: string; isDir: boolean };

function flattenTree(nodes: TreeNode[], out: FileItem[] = []): FileItem[] {
  for (const n of nodes) {
    out.push({ path: n.relative, isDir: n.isDir });
    if (n.isDir && n.children) flattenTree(n.children, out);
  }
  return out;
}

export default function Composer({
  value,
  busy,
  cwd,
  commands,
  attachments,
  dragOver,
  onAddAttachments,
  onRemoveAttachment,
  floating = false,
  placeholder = t('给 Grok 一个任务…', 'Give Grok a task…'),
  mode,
  modeBusy = false,
  availableModes,
  model,
  models,
  effort,
  effortOptions,
  sessionActive,
  pendingRequests = false,
  onChange,
  onSend,
  onStop,
  onModeChange,
  onModelChange,
  onEffortChange,
  onRememberNote,
  rememberState = 'idle',
  rememberDisabled = false,
  allowAttachments = true,
  focusRequest = 0,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  // IME 组合输入保护：compositionend 与确认键的 keydown 事件顺序有坑，加时间戳兜底
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(0);

  const modeMeta: PermissionModeMeta | undefined = permissionModes().find((m) => m.id === mode);
  const modeList: PermissionModeMeta[] = availableModes.length
    ? availableModes.map((m) => {
        const known = permissionModes().find((p) => p.id === m.id);
        return known || { id: m.id, label: m.name || m.id, hint: '' };
      })
    : permissionModes();

  useEffect(() => {
    if (floating) ref.current?.focus();
  }, [floating, focusRequest]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [openMenu]);

  const toggle = (menu: Exclude<OpenMenu, null>) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  // ——— `/` 斜杠命令菜单 + `@` 文件引用补全 ———
  const [menuIdx, setMenuIdx] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [fileItems, setFileItems] = useState<FileItem[] | null>(null);
  const fileCache = useRef<{ at: number; cwd: string; items: FileItem[] } | null>(null);

  // `/` 开头且未含空格 → 斜杠菜单（与 @ 菜单互斥）
  const slashActive = value.startsWith('/') && !value.includes(' ');
  const slashQuery = slashActive ? value.slice(1) : '';
  const slashItems = slashActive
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery.toLowerCase()))
    : [];

  // 输入末尾的 `@词` → 文件补全
  const atMatch = !slashActive ? /@(\S*)$/.exec(value) : null;
  const atQuery = atMatch ? atMatch[1] : null;
  const atActive = atQuery !== null;

  // 首次打开时拉一次工作区树，60s 内复用
  useEffect(() => {
    if (!atActive || !cwd) return;
    const now = Date.now();
    const cache = fileCache.current;
    if (cache && cache.cwd === cwd && now - cache.at < 60_000) {
      setFileItems(cache.items);
      return;
    }
    if (cache && cache.cwd === cwd && fileItems) return;
    let cancelled = false;
    invoke<TreeNode[]>('list_workdir_tree', { cwd })
      .then((tree) => {
        if (cancelled) return;
        const items = flattenTree(tree);
        fileCache.current = { at: Date.now(), cwd, items };
        setFileItems(items);
      })
      .catch(() => {
        if (!cancelled) setFileItems(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atActive, cwd]);

  const atItems =
    atActive && fileItems
      ? fileItems
          .filter((f) => !atQuery || f.path.toLowerCase().includes(atQuery.toLowerCase()))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir))
          .slice(0, 20)
      : [];

  const menuItemsCount = slashActive ? slashItems.length : atItems.length;
  const completeOpen =
    !menuDismissed && (slashActive || (atActive && fileItems !== null && atItems.length > 0));

  useEffect(() => {
    setMenuIdx(0);
  }, [slashQuery, atQuery]);

  const completeSlash = (c: AvailableCommand) => {
    onChange(`/${c.name} `);
    setMenuIdx(0);
    ref.current?.focus();
  };

  const completeFile = (f: FileItem) => {
    // 目录补全到 `path/` 便于继续输入；文件补全为 `path `
    const replacement = f.isDir ? `${f.path}/` : `${f.path} `;
    onChange(value.replace(/@(\S*)$/, replacement));
    setMenuIdx(0);
    ref.current?.focus();
  };

  const modelLabel = models.find((m) => m.id === model)?.name || model || t('默认模型', 'Default model');
  const effortLabel = effortOptions.find((o) => o.value === effort)?.label || effort || t('默认强度', 'Default effort');

  const pickFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: t('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
          {
            name: t('文档', 'Documents'),
            extensions: [
              'md', 'txt', 'pdf', 'json', 'csv', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs',
              'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'doc', 'docx', 'xls', 'xlsx',
              'ppt', 'pptx',
            ],
          },
        ],
      });
      if (!selected) return;
      onAddAttachments(Array.isArray(selected) ? selected : [selected]);
    } catch {
      /* 用户取消或对话框失败，忽略 */
    }
  };

  const attachIcon = (a: Attachment) => {
    const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
    if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'html', 'css', 'json', 'yaml', 'yml', 'toml'].includes(ext)) {
      return <FileCode2 size={13} />;
    }
    if (a.mimeType.startsWith('text/') || a.mimeType.includes('pdf') || a.mimeType.includes('word') || a.mimeType.includes('sheet') || a.mimeType.includes('presentation')) {
      return <FileText size={13} />;
    }
    return <File size={13} />;
  };

  return (
    <div className={`composer-card ${floating ? 'floating' : 'docked'} ${dragOver ? 'drag-over' : ''}`}>
      {dragOver && <div className="attach-drop-hint">{t('松开以添加附件', 'Drop to attach')}</div>}
      {completeOpen && (
        <div className="dropdown-menu complete-menu">
          {slashActive ? (
            slashItems.length ? (
              slashItems.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  className={`dropdown-item ${i === menuIdx ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    completeSlash(c);
                  }}
                >
                  <span className="complete-title">
                    <TerminalSquare size={13} />/{c.name}
                  </span>
                  <small>
                    {[c.description, c.input?.hint].filter(Boolean).join(' · ')}
                  </small>
                </button>
              ))
            ) : (
              <div className="dropdown-empty">
                {commands.length ? t('无匹配命令', 'No matching command') : t('开始会话后可用', 'Available after a session starts')}
              </div>
            )
          ) : (
            atItems.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className={`dropdown-item ${i === menuIdx ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  completeFile(f);
                }}
              >
                <span className="complete-title">
                  {f.isDir ? <FolderOpen size={13} /> : <FileText size={13} />}
                  {f.path}
                  {f.isDir ? '/' : ''}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {cwd && (
        <button
          type="button"
          className="ws-chip-inline"
          title={cwd}
          onClick={() => {
            if (isCompanion() || !isTauri()) return;
            invoke('open_in_finder', { path: cwd }).catch(() => {});
          }}
        >
          <FolderOpen size={12} />
          <span>{cwd.split('/').filter(Boolean).at(-1) || cwd}</span>
        </button>
      )}
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <span key={a.path} className="attach-chip" title={a.path}>
              {a.mimeType.startsWith('image/') ? (
                <img className="attach-thumb" src={convertFileSrc(a.path)} alt={a.name} />
              ) : (
                attachIcon(a)
              )}
              <span className="attach-name">{a.name}</span>
              <button
                type="button"
                className="attach-x"
                disabled={busy}
                aria-label={t(`移除附件 ${a.name}`, `Remove attachment ${a.name}`)}
                onClick={() => onRemoveAttachment(a.path)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="composer-textarea"
        value={value}
        placeholder={placeholder}
        rows={floating ? 3 : 2}
        onChange={(e) => {
          setMenuDismissed(false);
          onChange(e.target.value);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          compositionEndAtRef.current = Date.now();
        }}
        onKeyDown={(e) => {
          // IME 组合中（或刚结束 100ms 内）一切按键交还给输入法，不触发菜单/发送
          if (
            composingRef.current ||
            e.nativeEvent.isComposing ||
            e.keyCode === 229 ||
            Date.now() - compositionEndAtRef.current < 100
          ) {
            return;
          }
          if (completeOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setMenuIdx((i) => Math.min(i + 1, Math.max(menuItemsCount - 1, 0)));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setMenuIdx((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setMenuDismissed(true);
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && menuItemsCount > 0) {
              e.preventDefault();
              const target = slashActive ? slashItems[menuIdx] : atItems[menuIdx];
              if (target) {
                if (slashActive) completeSlash(target as AvailableCommand);
                else completeFile(target as FileItem);
                return;
              }
            }
          }
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (value.trim()) onSend();
        }}
      />

      <div className="composer-toolbar">
        {allowAttachments && (
        <button
          className="icon-btn soft"
          type="button"
          title={t('添加附件', 'Add attachment')}
          onClick={() => void pickFiles()}
        >
          <Paperclip size={15} />
        </button>
        )}
        <div
          className={`mode-picker ${modeMeta?.warn ? 'warn' : ''} ${modeBusy ? 'busy' : ''}`}
          role="button"
          tabIndex={0}
          title={
            modeBusy
              ? t('正在切换模式（重启 agent）…', 'Switching mode (restarting the agent)…')
              : sessionActive
                ? t('切换当前会话权限模式', 'Change permission mode for this session')
                : t('新会话将使用的权限模式', 'Permission mode for new sessions')
          }
          onClick={modeBusy ? undefined : toggle('mode')}
        >
          <Shield size={14} />
          <span>{modeMeta?.label || permissionModes().find((m) => m.id === mode)?.label || t('计划', 'Plan')}</span>
          {modeBusy ? <Loader2 size={12} className="spin" /> : <ChevronDown size={12} />}
          {openMenu === 'mode' && (
            <div className="dropdown-menu mode-menu" onClick={(e) => e.stopPropagation()}>
              {modeList.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`dropdown-item ${mode === m.id ? 'active' : ''} ${m.warn ? 'warn' : ''}`}
                  onClick={() => {
                    onModeChange(m.id);
                    setOpenMenu(null);
                  }}
                >
                  <span>{m.label}</span>
                  {m.hint && <small>{m.hint}</small>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          className="model-chip"
          role="button"
          tabIndex={0}
          title={sessionActive ? t('切换当前会话模型', 'Change model for this session') : t('新会话将使用的模型', 'Model for new sessions')}
          onClick={toggle('model')}
        >
          <Cpu size={14} />
          <span>{modelLabel}</span>
          <ChevronDown size={12} />
          {openMenu === 'model' && (
            <div className="dropdown-menu" onClick={(e) => e.stopPropagation()}>
              {!models.length && <div className="dropdown-empty">{t('未取得模型目录', 'Model list is unavailable')}</div>}
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`dropdown-item ${model === m.id ? 'active' : ''}`}
                  onClick={() => {
                    onModelChange(m.id);
                    setOpenMenu(null);
                  }}
                >
                  <span>
                    {m.name}
                    {m.isDefault ? t('（默认）', '(default)') : ''}
                  </span>
                  <small>{m.id}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          className="model-chip"
          role="button"
          tabIndex={0}
          title={sessionActive ? t('切换当前会话推理强度', 'Change reasoning effort for this session') : t('新会话将使用的推理强度', 'Reasoning effort for new sessions')}
          onClick={toggle('effort')}
        >
          <Brain size={14} />
          <span>{effortLabel}</span>
          <ChevronDown size={12} />
          {openMenu === 'effort' && (
            <div className="dropdown-menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`dropdown-item ${!effort ? 'active' : ''}`}
                onClick={() => {
                  onEffortChange('');
                  setOpenMenu(null);
                }}
              >
                <span>{t('跟随 CLI 默认', 'Follow the CLI default')}</span>
              </button>
              {effortOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`dropdown-item ${effort === o.value ? 'active' : ''}`}
                  onClick={() => {
                    onEffortChange(o.value);
                    setOpenMenu(null);
                  }}
                >
                  <span>{o.label}</span>
                  <small>{o.value}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="toolbar-spacer" />

        {onRememberNote && (
          <button
            className={`icon-btn soft remember-btn ${rememberState === 'done' ? 'done' : ''}`}
            type="button"
            title={rememberDisabled ? t('自动记忆已关闭', 'Auto memory is off') : t('记住这条', 'Remember this')}
            disabled={rememberDisabled || rememberState === 'saving'}
            onClick={onRememberNote}
          >
            {rememberState === 'done' ? (
              <Check size={15} />
            ) : rememberState === 'saving' ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <BookmarkPlus size={15} />
            )}
          </button>
        )}

        {busy ? (
          <button
            className={`send-circle ${value.trim() ? 'queue-send' : 'stop'}`}
            type="button"
            aria-label={value.trim() ? t('加入发送队列', 'Queue message') : t('停止生成', 'Stop')}
            title={
              value.trim()
                ? t('排队，当前轮结束后自动发送', 'Queued. Sends when the current turn finishes')
                : pendingRequests
                  ? t('停止（将自动拒绝所有待批准请求）', 'Stop (pending approvals will be rejected)')
                  : t('停止生成', 'Stop')
            }
            onClick={value.trim() ? onSend : onStop}
          >
            {value.trim() ? <ArrowUp size={16} /> : <Square size={12} />}
          </button>
        ) : (
          <button
            className="send-circle"
            type="button"
            title={t('发送', 'Send')}
            disabled={!value.trim()}
            onClick={onSend}
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
