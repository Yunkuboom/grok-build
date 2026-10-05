import type { PermissionRequest } from '../types';
import { textFrom } from '../types';
import { Check, Shield, X } from '../icons';
import { t } from '../i18n';


interface Props {
  permission: PermissionRequest;
  onReply: (optionId: string | null) => void;
}

export default function PermissionCard({ permission, onReply }: Props) {
  const detail = textFrom(permission.toolCall);
  return (
    <div className="permission-card">
      <div className="permission-head">
        <Shield size={16} />
        <strong>{t('Grok 请求执行工具', 'Grok wants to run a tool')}</strong>
      </div>
      {detail && <p className="permission-detail">{detail}</p>}
      <div className="permission-actions">
        {permission.options.map((o) => (
          <button key={o.optionId} type="button" onClick={() => onReply(o.optionId)}>
            <Check size={14} />
            {o.name}
          </button>
        ))}
        <button type="button" className="secondary" onClick={() => onReply(null)}>
          <X size={14} />
          {t('拒绝', 'Deny')}</button>
      </div>
    </div>
  );
}
