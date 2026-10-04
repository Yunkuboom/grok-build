import { useEffect, useRef } from 'react';

interface Props {
  initial: string;
  busy?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** 内联改名输入框：Enter 提交 / Esc 取消 / blur 取消，挂载即全选聚焦 */
export default function InlineRename({ initial, busy = false, placeholder, onSubmit, onCancel }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={initial}
      placeholder={placeholder}
      disabled={busy}
      aria-label="重命名会话"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') onSubmit(e.currentTarget.value.trim());
        else if (e.key === 'Escape') onCancel();
      }}
      onBlur={onCancel}
    />
  );
}
