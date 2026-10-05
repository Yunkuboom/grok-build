import { useEffect, useState } from 'react';
import { permissionModes } from '../types';
import { FolderOpen, MessageSquarePlus, Shield, Zap } from '../icons';
import grokLogo from '../assets/grok-logo.png';
import { t } from '../i18n';


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

  const modeLabel = permissionModes().find((m) => m.id === mode)?.label || t('计划', 'Plan');

  return (
    <div className="home-hero">
      <div className="home-brand" aria-hidden>
        <img src={grokLogo} alt="" draggable={false} />
      </div>
      <h1 className="home-greeting">{t('准备构建什么？', 'What should we build?')}</h1>
      <div className="quick-chips">
        <button className="quick-chip" type="button" onClick={onChooseFolder}>
          <FolderOpen size={14} />
          {t('选择工作区', 'Choose workspace')}</button>
        <button className="quick-chip" type="button" onClick={onNewSession}>
          <MessageSquarePlus size={14} />
          {t('新建任务', 'New task')}</button>
        <span className="home-mode-wrap">
          <button
            className="quick-chip"
            type="button"
            title={t('新会话的默认权限模式', 'Default permission mode for new sessions')}
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
              {permissionModes().map((m) => (
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
          title={t('新会话开启 superpowers 重型工程模式', 'Start new sessions with the superpowers plugin')}
          onClick={onToggleSp}
        >
          <Zap size={14} />
          {t('SP 超能', 'Superpowers')}</button>
      </div>
    </div>
  );
}
