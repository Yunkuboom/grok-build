import { useRef, useState } from 'react';
import { Check, Copy } from '../icons';
import { t } from '../i18n';


interface Props {
  text: string;
  className?: string;
  title?: string;
  size?: number;
}

export default function CopyButton({ text, className = '', title = t('复制', 'Copy'), size = 12 }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'done' : ''} ${className}`}
      onClick={(e) => void copy(e)}
      title={copied ? t('已复制', 'Copied') : title}
      aria-label={copied ? t('已复制', 'Copied') : title}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
