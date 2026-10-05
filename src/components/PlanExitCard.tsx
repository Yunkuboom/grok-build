import { useState } from 'react';
import type { ExitPlanOutcome, ExitPlanRequest } from '../types';
import Markdown from './Markdown';
import { Check, Loader2, Pencil, ScrollText, X } from '../icons';
import { t } from '../i18n';


interface Props {
  request: ExitPlanRequest;
  onSubmit: (outcome: ExitPlanOutcome, feedback?: string) => Promise<void>;
}

export default function PlanExitCard({ request, onSubmit }: Props) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const send = async (outcome: ExitPlanOutcome, fb?: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(outcome, fb);
    } catch {
      /* 错误已由父级 banner 展示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="permission-card plan-exit-card">
      <div className="permission-head">
        <ScrollText size={16} />
        <strong>{t('计划待批准', 'Plan awaiting approval')}</strong>
      </div>

      <div className="plan-exit-content md-preview">
        {request.planContent ? (
          <Markdown>{request.planContent}</Markdown>
        ) : (
          <span className="muted">{t('（未附带计划内容）', '(no plan text was attached)')}</span>
        )}
      </div>

      {feedbackOpen && (
        <textarea
          className="plan-exit-feedback"
          placeholder={t('输入修改意见，Grok 会按此调整计划…', 'Tell Grok what to change in the plan…')}
          value={feedback}
          autoFocus
          rows={3}
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}

      <div className="permission-actions">
        <button type="button" disabled={submitting} onClick={() => void send('approved')}>
          {submitting ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
          {t('批准执行', 'Approve and run')}
        </button>
        {feedbackOpen ? (
          <button
            type="button"
            className="secondary"
            disabled={submitting || !feedback.trim()}
            onClick={() => void send('request_changes', feedback.trim())}
          >
            <Pencil size={14} />
            {t('提交修改意见', 'Send changes')}</button>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={submitting}
            onClick={() => setFeedbackOpen(true)}
          >
            <Pencil size={14} />
            {t('要求修改', 'Request changes')}</button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={submitting}
          onClick={() => void send('abandoned')}
        >
          <X size={14} />
          {t('继续规划', 'Keep planning')}</button>
      </div>
    </div>
  );
}
