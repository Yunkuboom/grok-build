import { useRef, useState } from 'react';
import { Check, Copy } from '../icons';

interface Props {
  text: string;
  className?: string;
  title?: string;
  size?: number;
}

export default function CopyButton({ text, className = '', title = '复制', size = 12 }: Props) {
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
      title={copied ? '已复制' : title}
      aria-label={copied ? '已复制' : title}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
