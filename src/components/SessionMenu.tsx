import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionEntry } from '../types';
import {
  Archive,
  ChartColumn,
  ClipboardCopy,
  Copy,
  Eye,
  EyeOff,
  GitFork,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from '../icons';
import { t } from '../i18n';

interface Props {
  x: number;
  y: number;
  session: SessionEntry;
  pinned: boolean;
  hidden: boolean;
  onClose: () => void;
  onRename: () => void;
  onCopyId: () => void;
  onUsage: () => void;
  onFork: () => void;
  onExportTrace: () => void;
  onExport: () => void;
  onRestoreCode: () => void;
  onTogglePin: () => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}

/** 会话行右键菜单（对标 Kimi Code）：自绘、键盘可达、靠边翻转 */
export default function SessionMenu({
  x,
  y,
  session,
  pinned,
  hidden,
  onClose,
  onRename,
  onCopyId,
  onUsage,
  onFork,
  onExportTrace,
  onExport,
  onRestoreCode,
  onTogglePin,
  onToggleHidden,
  onDelete,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - r.width - 8);
    if (ny + r.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x: nx, y: ny });
    el.querySelector<HTMLButtonElement>('.session-menu-item')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = () => onClose();
    // 关键：延迟到下一个 task 再注册关闭监听。
    // React 18 在离散事件（contextmenu）里会同步 flush 渲染与 passive effects，
    // 若立即注册，打开菜单的同一个 contextmenu/mousedown 事件继续冒泡到 window
    // 时会被 onDown 当成"点外部"把菜单立刻关掉。
    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('contextmenu', onDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('contextmenu', onDown);
    };
  }, [onClose]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('.session-menu-item') || [],
    );
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const item = (
    icon: React.ReactNode,
    label: string,
    action: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      role="menuitem"
      className={`session-menu-item ${danger ? 'danger' : ''}`}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      className="session-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onMenuKey}
    >
      {item(<Pencil size={14} />, t('重命名', 'Rename'), onRename)}
      {item(<Copy size={14} />, t('复制 Session ID', 'Copy session ID'), onCopyId)}
      {item(<ChartColumn size={14} />, t('查看用量', 'View usage'), onUsage)}
      {item(<GitFork size={14} />, t('分叉会话', 'Fork session'), onFork)}
      {item(<Archive size={14} />, t('导出 trace', 'Export trace'), onExportTrace)}
      {item(<ClipboardCopy size={14} />, t('导出会话（Markdown）', 'Export session (Markdown)'), onExport)}
      {item(<RotateCcw size={14} />, t('恢复并还原代码快照', 'Restore and recover the code snapshot'), onRestoreCode)}
      {item(pinned ? <PinOff size={14} /> : <Pin size={14} />, pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin'), onTogglePin)}
      {item(
        hidden ? <Eye size={14} /> : <EyeOff size={14} />,
        hidden ? t('取消隐藏', 'Unhide') : t('隐藏', 'Hide'),
        onToggleHidden,
      )}
      <div className="session-menu-sep" />
      {item(<Trash2 size={14} />, t('删除', 'Delete'), onDelete, true)}
      <div className="session-menu-footer">{t('最后更新：', 'Last updated: ')}{session.updated ?? t('未知', 'Unknown')}</div>
    </div>
  );
}
