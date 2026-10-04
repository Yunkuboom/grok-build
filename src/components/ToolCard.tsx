import { useState } from 'react';
import type { ChatMessage } from '../types';
import { ChevronRight, Loader2, Wrench } from '../icons';

function statusMeta(status?: string): { cls: 'running' | 'done' | 'error'; label: string } {
  const s = (status || '').toLowerCase();
  if (s === 'in_progress' || s === 'running' || s === 'pending') return { cls: 'running', label: '进行中' };
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return { cls: 'error', label: '失败' };
  return { cls: 'done', label: '完成' };
}

export default function ToolCard({ message }: { message: ChatMessage }) {
  const meta = statusMeta(message.toolStatus);
  const running = meta.cls === 'running';
  const [open, setOpen] = useState(false);

  return (
    <div className={`tool-card ${meta.cls}`}>
      <button type="button" className="tool-card-header" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`tool-card-chevron ${open ? 'open' : ''}`} />
        <Wrench size={13} className="tool-card-icon" />
        <span className="tool-card-name">{message.toolTitle || '工具调用'}</span>
        <span className={`tool-card-status ${meta.cls}`}>
          {running && <Loader2 size={12} className="spin" />}
          {meta.label}
        </span>
      </button>
      {open && message.text && (
        <div className="tool-card-body">
          <pre className="tool-card-pre">{message.text}</pre>
        </div>
      )}
    </div>
  );
}
