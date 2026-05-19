// Scratch pad — the HUD's ~340x360 expanded panel.
//
// Two jobs:
//   1. Show a fresh agent response (long replies expand here instead of the
//      pill). Reuses ResultPanel so response rendering isn't duplicated.
//   2. Re-readable history — the local-only ring buffer from lib/history.ts,
//      scrollable, newest at the bottom (chat-log reading order).
//
// History is loaded fresh each time the pad opens. It is never cloud-synced.

import { useEffect, useState } from 'react';
import { ChevronUp, History as HistoryIcon, Settings as SettingsIcon, X } from 'lucide-react';
import { ResultPanel } from './ResultPanel';
import { loadHistory, type HistoryEntry } from '../lib/history';
import type { VoiceResponse } from '../lib/api';

interface Props {
  // The current (fresh) response, if any — rendered above the history list.
  response: VoiceResponse | null;
  error: string | null;
  apiUrl: string;
  // Collapse the pad back to the idle pill.
  onCollapse: () => void;
  // Dismiss the whole HUD.
  onDismiss: () => void;
  // Open the settings panel (settings lives in the pad header to keep the
  // idle pill uncluttered).
  onOpenSettings: () => void;
}

// "2m ago" / "just now" — relative timestamps keep the list scannable.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function ScratchPad({
  response,
  error,
  apiUrl,
  onCollapse,
  onDismiss,
  onOpenSettings,
}: Props) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Reload history every time the pad mounts so a just-finished interaction
  // shows up. loadHistory() reads the local JSON ring buffer.
  useEffect(() => {
    let alive = true;
    void loadHistory().then((h) => {
      if (alive) setHistory(h);
    });
    return () => {
      alive = false;
    };
  }, [response]);

  return (
    <div className="flex h-full flex-col">
      {/* Header — collapse, title, settings, dismiss. */}
      <div className="hud-drag flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse to pill"
          className="hud-no-drag flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <span className="flex flex-1 items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
          <HistoryIcon className="h-3.5 w-3.5" />
          Scratch pad
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          className="hud-no-drag flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="hud-no-drag flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Scrollable body — fresh response, then history. */}
      <div className="hud-scroll min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="border-t border-white/5 px-4 py-3 text-sm text-rose-300">{error}</div>
        ) : response ? (
          <div className="border-t border-white/5">
            <ResultPanel response={response} apiUrl={apiUrl} onDismiss={onDismiss} />
          </div>
        ) : null}

        <div className="border-t border-white/5">
          {history.length === 0 ? (
            <p className="px-4 py-4 text-xs text-slate-500">
              No history yet. Your prompts and replies appear here — stored locally,
              never synced.
            </p>
          ) : (
            <ul className="space-y-2 px-3 py-3">
              {/* Oldest first, newest at the bottom — chat-log reading order. */}
              {history.map((entry, i) => (
                <li
                  key={`${entry.ts}-${i}`}
                  className="rounded-lg bg-white/[0.03] px-3 py-2"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] text-slate-200">{entry.prompt}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
                      {relativeTime(entry.ts)}
                    </span>
                  </div>
                  {entry.intent && (
                    <span className="mt-0.5 inline-block text-[10px] uppercase tracking-wide text-ergora-amber/80">
                      {entry.intent}
                    </span>
                  )}
                  {entry.reply && (
                    <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
                      {entry.reply}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
