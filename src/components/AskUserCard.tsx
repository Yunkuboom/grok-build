import { useState } from 'react';
import type { AskRequest } from '../types';
import Markdown from './Markdown';
import { Check, ChevronRight, Loader2, MessageCircleQuestion, X } from '../icons';

interface Props {
  request: AskRequest;
  onSubmit: (answers: Record<string, string | string[]>) => Promise<void>;
  onCancel: () => void;
}

export default function AskUserCard({ request, onSubmit, onCancel }: Props) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const answerFor = (i: number): string | string[] | null => {
    const text = (custom[i] || '').trim();
    if (text) return text;
    const sel = selected[i] || [];
    if (!sel.length) return null;
    const q = request.questions[i];
    return q.multiSelect ? sel : sel[0];
  };

  const allAnswered = request.questions.every((_, i) => answerFor(i) !== null);

  const toggleOption = (qi: number, label: string) => {
    const q = request.questions[qi];
    setSelected((prev) => {
      const current = prev[qi] || [];
      if (q.multiSelect) {
        return {
          ...prev,
          [qi]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
        };
      }
      return { ...prev, [qi]: current.includes(label) ? [] : [label] };
    });
  };

  const submit = async () => {
    if (!allAnswered || submitting) return;
    const answers: Record<string, string | string[]> = {};
    request.questions.forEach((q, i) => {
      const value = answerFor(i);
      if (value !== null) answers[q.question] = value;
    });
    setSubmitting(true);
    try {
      await onSubmit(answers);
    } catch {
      /* 错误已由父级 banner 展示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="permission-card ask-card">
      <div className="permission-head">
        <MessageCircleQuestion size={16} />
        <strong>Grok 想问你</strong>
      </div>

      <div className="ask-questions">
        {request.questions.map((q, qi) => {
          const options = q.options || [];
          const sel = selected[qi] || [];
          const showCustom = customOpen[qi] || !options.length;
          return (
            <div key={qi} className="ask-question">
              {q.preview && (
                <div className="ask-preview md-preview">
                  <Markdown>{q.preview}</Markdown>
                </div>
              )}
              <div className="ask-question-text">
                {q.question}
                {q.multiSelect ? <span className="ask-multi-hint">（可多选）</span> : null}
              </div>

              {options.length > 0 && (
                <div className="ask-options">
                  {options.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className={`ask-option ${sel.includes(o.label) ? 'active' : ''}`}
                      aria-pressed={sel.includes(o.label)}
                      onClick={() => toggleOption(qi, o.label)}
                    >
                      <span className="ask-option-check">
                        {sel.includes(o.label) && <Check size={11} />}
                      </span>
                      <span className="ask-option-body">
                        <span className="ask-option-label">{o.label}</span>
                        {o.description && <small>{o.description}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {options.length > 0 && !showCustom && (
                <button
                  type="button"
                  className="ask-custom-toggle"
                  onClick={() => setCustomOpen((p) => ({ ...p, [qi]: true }))}
                >
                  <ChevronRight size={11} />
                  自定义答案
                </button>
              )}
              {showCustom && (
                <input
                  className="ask-custom-input"
                  placeholder="或输入自定义答案…"
                  value={custom[qi] || ''}
                  onChange={(e) =>
                    setCustom((p) => ({ ...p, [qi]: e.target.value }))
                  }
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="permission-actions">
        <button type="button" disabled={!allAnswered || submitting} onClick={() => void submit()}>
          {submitting ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
          提交
        </button>
        <button type="button" className="secondary" disabled={submitting} onClick={onCancel}>
          <X size={14} />
          取消
        </button>
      </div>
    </div>
  );
}
