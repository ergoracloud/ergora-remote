import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
}

export function KeyboardInput({ value, onChange, onSubmit, busy, placeholder }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus when keyboard mode mounts.
    ref.current?.focus();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && value.trim()) {
          e.preventDefault();
          onSubmit();
        }
      }}
      disabled={busy}
      placeholder={placeholder ?? 'Type a question, command, or "note: …"'}
      className="hud-no-drag w-full bg-transparent text-[15px] text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-60"
    />
  );
}
