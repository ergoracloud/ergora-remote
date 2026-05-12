import { Mic, MicOff } from 'lucide-react';

interface Props {
  recording: boolean;
  level: number;
  busy?: boolean;
  onClick: () => void;
}

// Big circular mic. The pulse "ring" scales with `level` while recording —
// keeps the user oriented that the HUD is hearing them.
export function MicButton({ recording, level, busy, onClick }: Props) {
  const ringScale = recording ? 1 + Math.min(0.4, level * 0.6) : 1;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={recording ? 'Stop recording' : 'Start recording'}
      className="hud-no-drag relative flex h-10 w-10 items-center justify-center rounded-full bg-ergora-green text-white transition-colors hover:bg-ergora-green-soft focus:outline-none focus:ring-2 focus:ring-ergora-amber/60 disabled:opacity-60"
    >
      {recording && (
        <span
          className="pointer-events-none absolute inset-0 rounded-full bg-ergora-green/40 animate-pulse-soft"
          style={{ transform: `scale(${ringScale})` }}
        />
      )}
      {recording ? <MicOff className="relative h-4 w-4" /> : <Mic className="relative h-4 w-4" />}
    </button>
  );
}
