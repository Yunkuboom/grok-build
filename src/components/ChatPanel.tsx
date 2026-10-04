import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import ToolCard from './ToolCard';
import Markdown from './Markdown';
import CopyButton from './CopyButton';
import { Brain, Check, ChevronRight, ListTodo, Loader2 } from '../icons';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  trimmed: boolean;
  onJumpVisibilityChange?: (show: boolean) => void;
  jumpRef?: React.MutableRefObject<(() => void) | null>;
}

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const fmtTok = (n: number) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

function MsgFooter({ text, ts, turnTokens }: { text: string; ts?: number; turnTokens?: number }) {
  return (
    <div className="msg-footer">
      <CopyButton text={text} title="复制消息" />
      {ts !== undefined && <time>{fmtTime(ts)}</time>}
      {turnTokens !== undefined && (
        <span className="msg-tokens">
          {ts !== undefined ? ' | ' : ''}
          {fmtTok(turnTokens)} tok
        </span>
      )}
    </div>
  );
}

function ThoughtBlock({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thought-block ${message.streaming ? 'streaming' : ''}`}>
      <button type="button" className="thought-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`tool-card-chevron ${open ? 'open' : ''}`} />
        <Brain size={13} />
        <span>思考过程{message.streaming ? '…' : ''}</span>
      </button>
      {open && <div className="thought-body">{message.text}</div>}
      <MsgFooter text={message.text} ts={message.ts} turnTokens={message.turnTokens} />
    </div>
  );
}

function PlanCard({ entries }: { entries: NonNullable<ChatMessage['planEntries']> }) {
  return (
    <div className="plan-card">
      <div className="plan-head">
        <ListTodo size={14} />
        <strong>计划</strong>
      </div>
      <ul className="plan-list">
        {entries.map((e, i) => {
          const status = (e.status || 'pending').toLowerCase();
          const cls =
            status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending';
          return (
            <li key={i} className={`plan-item ${cls}`}>
              <span className="plan-check">
                {cls === 'completed' ? (
                  <Check size={11} />
                ) : cls === 'in_progress' ? (
                  <Loader2 size={11} className="spin" />
                ) : null}
              </span>
              <span className="plan-text">{e.content}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function ChatPanel({ messages, busy, trimmed, onJumpVisibilityChange, jumpRef }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followRef.current) el.scrollTop = el.scrollHeight;
    // 新内容到达时同步 pill 可见性（用户在底部则隐藏）
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(dist > 200);
  }, [messages, busy]);

  useEffect(() => {
    onJumpVisibilityChange?.(showJump);
  }, [showJump, onJumpVisibilityChange]);

  useEffect(() => {
    if (!jumpRef) return;
    jumpRef.current = () => {
      followRef.current = true;
      setShowJump(false);
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    };
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = dist < 80;
    setShowJump(dist > 200);
  };

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      {trimmed && <div className="trim-notice">更早的消息已从界面裁剪（仍保存在 Grok 会话中）</div>}
      {messages.map((m) => {
        if (m.role === 'tool') {
          return (
            <div key={m.id} id={`msg-${m.id}`} className="msg tool">
              <ToolCard message={m} />
              <MsgFooter text={[m.toolTitle, m.text].filter(Boolean).join('\n')} ts={m.ts} turnTokens={m.turnTokens} />
            </div>
          );
        }
        if (m.role === 'plan') {
          return (
            <div key={m.id} id={`msg-${m.id}`} className="msg plan">
              <PlanCard entries={m.planEntries || []} />
            </div>
          );
        }
        if (m.role === 'thought') {
          return (
            <div key={m.id} id={`msg-${m.id}`} className="msg thought">
              <ThoughtBlock message={m} />
            </div>
          );
        }
        return (
          <div key={m.id} id={`msg-${m.id}`} className={`msg ${m.role} ${m.streaming ? 'streaming' : ''}`}>
            <div className="msg-role">{m.role === 'user' ? '你' : 'Grok'}</div>
            {m.role === 'assistant' && !m.streaming ? (
              <div className="msg-bubble msg-body md-preview">
                <Markdown>{m.text}</Markdown>
              </div>
            ) : (
              <div className={m.role === 'assistant' ? 'msg-bubble msg-body' : 'msg-bubble'}>
                {m.text}
                {m.streaming && <span className="cursor" />}
              </div>
            )}
            <MsgFooter text={m.text} ts={m.ts} turnTokens={m.turnTokens} />
          </div>
        );
      })}
      {busy && messages.at(-1)?.role === 'user' && (
        <div className="msg assistant">
          <div className="msg-role">Grok</div>
          <div className="thinking">
            <i />
            <i />
            <i />
          </div>
        </div>
      )}
      <div className="chat-scroll-end" aria-hidden />
    </div>
  );
}
