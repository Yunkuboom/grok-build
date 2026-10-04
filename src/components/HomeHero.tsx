import { useEffect, useState } from 'react';
import { PERMISSION_MODES } from '../types';
import { FolderOpen, MessageSquarePlus, Shield, Zap } from '../icons';
import grokLogo from '../assets/grok-logo.png';

interface Props {
  mode: string;
  spEnabled: boolean;
  onChooseFolder: () => void;
  onNewSession: () => void;
  onModeChange: (modeId: string) => void;
  onToggleSp: () => void;
}

export default function HomeHero({
  mode,
  spEnabled,
  onChooseFolder,
  onNewSession,
  onModeChange,
  onToggleSp,
}: Props) {
  const [modeOpen, setModeOpen] = useState(false);

  useEffect(() => {
    if (!modeOpen) return;
    const close = () => setModeOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [modeOpen]);

  const modeLabel = PERMISSION_MODES.find((m) => m.id === mode)?.label || '计划';

  return (
    <div className="home-hero">
      <div className="home-brand" aria-hidden>
        <img src={grokLogo} alt="" draggable={false} />
      </div>
      <h1 className="home-greeting">准备构建什么？</h1>
      <div className="quick-chips">
        <button className="quick-chip" type="button" onClick={onChooseFolder}>
          <FolderOpen size={14} />
          选择工作区
        </button>
        <button className="quick-chip" type="button" onClick={onNewSession}>
          <MessageSquarePlus size={14} />
          新建任务
        </button>
        <span className="home-mode-wrap">
          <button
            className="quick-chip"
            type="button"
            title="新会话的默认权限模式"
            onClick={(e) => {
              e.stopPropagation();
              setModeOpen((v) => !v);
            }}
          >
            <Shield size={14} />
            {modeLabel}
          </button>
          {modeOpen && (
            <div className="dropdown-menu home-mode-menu" onClick={(e) => e.stopPropagation()}>
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`dropdown-item ${mode === m.id ? 'active' : ''} ${m.warn ? 'warn' : ''}`}
                  onClick={() => {
                    onModeChange(m.id);
                    setModeOpen(false);
                  }}
                >
                  <span>{m.label}</span>
                  {m.hint && <small>{m.hint}</small>}
                </button>
              ))}
            </div>
          )}
        </span>
        <button
          className={`quick-chip sp-chip ${spEnabled ? 'on' : ''}`}
          type="button"
          title="新会话开启 superpowers 重型工程模式"
          onClick={onToggleSp}
        >
          <Zap size={14} />
          SP 超能
        </button>
      </div>
    </div>
  );
}
