import { useState } from 'react';

interface Props {
  userMessages: Array<{ id: string; text: string }>;
  onJump: (id: string) => void;
}

/** 用户消息导航轨道：minimap 式 tick + hover 弹出回溯列表 */
export default function MessageNav({ userMessages, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  if (userMessages.length < 2) return null;

  return (
    <div
      className="msg-nav"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false);
        setHoverId(null);
      }}
    >
      <div className="msg-nav-track">
        {userMessages.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className="msg-nav-tick"
            onMouseEnter={() => setHoverId(m.id)}
            onClick={(e) => {
              // 点击 tick 只做强调 + 确保浮窗打开，不跳转（跳转走浮窗条目）
              setHoverId(m.id);
              setOpen(true);
              e.currentTarget.blur();
            }}
            aria-label={`第 ${i + 1} 条你的消息`}
          />
        ))}
      </div>
      <div className={`msg-nav-pop ${open ? 'open' : ''}`}>
        {userMessages.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`msg-nav-item ${hoverId === m.id ? 'active' : ''}`}
            onMouseEnter={() => setHoverId(m.id)}
            onClick={() => {
              onJump(m.id);
              setOpen(false);
            }}
          >
            {m.text.length > 20 ? `${m.text.slice(0, 20)}…` : m.text}
          </button>
        ))}
      </div>
    </div>
  );
}
