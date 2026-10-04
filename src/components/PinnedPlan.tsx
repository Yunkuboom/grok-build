import { useEffect, useRef, useState } from 'react';
import type { PlanEntry } from '../types';
import { Check, ChevronDown, ChevronUp, ListTodo, Loader2 } from '../icons';

interface Props {
  entries: PlanEntry[];
}

/** 钉住的计划面板：输入框上方常驻，可折叠；新 plan 更新时自动展开一次 */
export default function PinnedPlan({ entries }: Props) {
  const [open, setOpen] = useState(true);
  const prevSig = useRef('');

  useEffect(() => {
    const sig = entries.map((e) => `${e.content}:${e.status ?? ''}`).join('|');
    if (sig === prevSig.current) return;
    prevSig.current = sig;
    setOpen((o) => o || true);
  }, [entries]);

  const done = entries.filter((e) => (e.status || '').toLowerCase() === 'completed').length;
  const total = entries.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="pinned-plan">
      <button
        type="button"
        className="pinned-plan-bar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ListTodo size={13} />
        <span className="pinned-plan-title">
          计划 · {done}/{total}
        </span>
        <span className="pinned-plan-progress">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="pinned-plan-pct">{pct}%</span>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {open && (
        <ul className="pinned-plan-body plan-list">
          {entries.map((e, i) => {
            const status = (e.status || 'pending').toLowerCase();
            const cls =
              status === 'completed'
                ? 'completed'
                : status === 'in_progress'
                  ? 'in_progress'
                  : 'pending';
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
      )}
    </div>
  );
}
