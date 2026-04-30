// Ergora HUD — top-of-screen voice + keyboard overlay.
//
// Flow:
//   1. Hotkey or tray click → Rust shows the window → React mounts.
//   2. Default is mic mode. Click mic / press hotkey again → start recording.
//   3. Silence detection or manual stop → POST audio to /api/transcribe.
//   4. Transcribed text → POST to /api/voice → render the per-intent result.
//   5. Esc / blur / explicit dismiss → window hides (Rust side).
//
// We keep all networking in lib/api.ts and all media plumbing in
// hooks/useRecorder.ts so the App component reads top-to-bottom as a state
// machine.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Mic, Settings as SettingsIcon, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MicButton } from './components/MicButton';
import { KeyboardInput } from './components/KeyboardInput';
import { ResultPanel } from './components/ResultPanel';
import { useRecorder } from './hooks/useRecorder';
import { useHudWindow } from './hooks/useHudWindow';
import {
  loadConfig,
  loadPrefs,
  savePrefs,
  type ErgoraConfig,
  type UserPrefs,
} from './lib/config';
import { appendHistory } from './lib/history';
import {
  chatComplete,
  dispatchVoice,
  synthesize,
  transcribe,
  type VoiceResponse,
} from './lib/api';

type Mode = 'mic' | 'keyboard';
type Phase = 'idle' | 'recording' | 'transcribing' | 'dispatching' | 'speaking' | 'done' | 'error';

export default function App() {
  const { hide, setExpanded } = useHudWindow();
  const recorder = useRecorder();

  const [mode, setMode] = useState<Mode>('mic');
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [keyboardText, setKeyboardText] = useState('');
  const [response, setResponse] = useState<VoiceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [config, setConfig] = useState<ErgoraConfig | null>(null);
  const [missingConfig, setMissingConfig] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Boot — config + prefs + initial mic permission probe ──────────────
  useEffect(() => {
    (async () => {
      const status = await loadConfig();
      setConfig(status.config);
      setMissingConfig(status.missing);
      setPrefs(await loadPrefs());
    })();
  }, []);

  // Esc dismisses; the Rust side already hides on blur, but we also catch the
  // key here so the user can dismiss without clicking out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void hide();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hide]);

  // Auto-grow / shrink the window when the result panel mounts/unmounts.
  useEffect(() => {
    setExpanded(Boolean(response) || Boolean(error) || phase === 'transcribing' || phase === 'dispatching');
  }, [response, error, phase, setExpanded]);

  // Listen for the global hotkey emitted from the Rust shell. The shell already
  // shows the window; here we toggle recording when the hotkey fires while the
  // window is visible.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Shift+Space inside the webview as a fallback.
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        if (mode === 'mic') {
          void toggleRecording();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, recorder.recording]);

  const reset = useCallback(() => {
    setTranscript('');
    setKeyboardText('');
    setResponse(null);
    setError(null);
    setPhase('idle');
  }, []);

  const dismiss = useCallback(() => {
    reset();
    void hide();
  }, [hide, reset]);

  const runDispatch = useCallback(
    async (text: string) => {
      if (!config) return;
      if (missingConfig.length > 0) {
        setError(`Missing ${missingConfig.join(', ')} — open Ergora Remote setup first.`);
        setPhase('error');
        return;
      }
      setPhase('dispatching');
      try {
        const projectId = prefs?.projectId ?? config.projectId ?? '';
        const r = await dispatchVoice(config, text, projectId);
        setResponse(r);
        setPhase('done');

        // Chat replies need a follow-up call to actually fetch the answer.
        if (r.ok && r.action === 'chat') {
          try {
            const chat = await chatComplete(config, r.payload.message, r.payload.projectId);
            setResponse({ ...r, replyText: chat.replyText });
            if (prefs?.ttsEnabled && chat.replyText) {
              setPhase('speaking');
              const blob = await synthesize(config, chat.replyText);
              if (blob.size > 0) {
                const url = URL.createObjectURL(blob);
                if (audioRef.current) {
                  audioRef.current.src = url;
                  await audioRef.current.play().catch(() => {});
                }
              }
              setPhase('done');
            }
            await appendHistory({
              ts: Date.now(),
              prompt: text,
              intent: 'chat',
              reply: chat.replyText,
            });
          } catch (err) {
            console.warn('[chat]', err);
          }
        } else if (r.ok) {
          await appendHistory({ ts: Date.now(), prompt: text, intent: r.action });
        }
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    },
    [config, missingConfig, prefs],
  );

  const toggleRecording = useCallback(async () => {
    if (!config) return;
    if (recorder.recording) {
      const blob = await recorder.stop();
      if (!blob || blob.size === 0) {
        setPhase('idle');
        return;
      }
      setPhase('transcribing');
      try {
        const r = await transcribe(config, blob);
        setTranscript(r.text);
        await runDispatch(r.text);
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    } else {
      reset();
      await recorder.start();
      setPhase('recording');
    }
  }, [config, recorder, reset, runDispatch]);

  const submitKeyboard = useCallback(async () => {
    const text = keyboardText.trim();
    if (!text) return;
    setTranscript(text);
    await runDispatch(text);
  }, [keyboardText, runDispatch]);

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      setMode(next);
      reset();
    },
    [mode, reset],
  );

  const hint = useMemo(() => {
    if (error) return error;
    if (phase === 'transcribing') return 'Transcribing…';
    if (phase === 'dispatching') return 'Routing…';
    if (phase === 'speaking') return 'Speaking…';
    if (mode === 'mic') {
      if (recorder.recording) return 'Listening…';
      return 'Tap to speak';
    }
    return '';
  }, [error, phase, mode, recorder.recording]);

  return (
    <div className="flex h-screen w-screen items-start justify-center pt-1">
      <div className="hud-no-drag relative w-[640px] overflow-hidden rounded-2xl border border-white/5 bg-slate-900/[0.92] shadow-hud backdrop-blur-hud animate-hud-in">
        {/* Drag handle — top 8px lets the user reposition the HUD by grabbing
            the empty space above the controls. */}
        <div className="hud-drag h-2 w-full" />

        <div className="flex h-12 items-center gap-3 px-3">
          {mode === 'mic' ? (
            <MicButton
              recording={recorder.recording}
              level={recorder.level}
              busy={phase === 'transcribing' || phase === 'dispatching'}
              onClick={() => void toggleRecording()}
            />
          ) : (
            <button
              type="button"
              onClick={() => switchMode('mic')}
              aria-label="Switch to mic mode"
              className="hud-no-drag flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-slate-200 hover:bg-white/10"
            >
              <Mic className="h-4 w-4" />
            </button>
          )}

          <div className="min-w-0 flex-1">
            {mode === 'keyboard' ? (
              <KeyboardInput
                value={keyboardText}
                onChange={setKeyboardText}
                onSubmit={submitKeyboard}
                busy={phase === 'transcribing' || phase === 'dispatching'}
              />
            ) : transcript ? (
              <div className="truncate text-sm text-slate-200">{transcript}</div>
            ) : (
              <div className="text-sm text-slate-400">{hint || 'Tap to speak'}</div>
            )}
          </div>

          {mode === 'mic' && (
            <span className="hidden text-[11px] uppercase tracking-wide text-slate-500 sm:block">
              {hint}
            </span>
          )}

          {/* Mode toggle — small icon button. */}
          <button
            type="button"
            onClick={() => switchMode(mode === 'mic' ? 'keyboard' : 'mic')}
            aria-label={mode === 'mic' ? 'Switch to keyboard' : 'Switch to mic'}
            className="hud-no-drag flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            {mode === 'mic' ? <Keyboard className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>

          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            aria-label="Settings"
            className="hud-no-drag flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="hud-no-drag flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {missingConfig.length > 0 && (
          <div className="border-t border-white/5 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
            Ergora Remote isn't configured yet. Add{' '}
            <code className="rounded bg-black/30 px-1 py-0.5">{missingConfig.join(', ')}</code> to{' '}
            <code className="rounded bg-black/30 px-1 py-0.5">~/.ergora-remote/.env</code>.
          </div>
        )}

        {(response || error) && (
          <div className="border-t border-white/5">
            {error ? (
              <div className="px-4 py-3 text-sm text-rose-300">{error}</div>
            ) : response ? (
              <ResultPanel
                response={response}
                apiUrl={config?.apiUrl ?? 'https://ergora.cloud'}
                onDismiss={dismiss}
              />
            ) : null}
          </div>
        )}

        {showSettings && prefs && (
          <SettingsPanel
            prefs={prefs}
            onChange={async (next) => {
              setPrefs(next);
              await savePrefs(next);
              if (next.hotkey !== prefs.hotkey) {
                await invoke('set_global_hotkey', { accelerator: next.hotkey }).catch(() => {});
              }
            }}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* Hidden audio element for TTS playback. */}
        <audio ref={audioRef} hidden />
      </div>
    </div>
  );
}

function SettingsPanel({
  prefs,
  onChange,
  onClose,
}: {
  prefs: UserPrefs;
  onChange: (p: UserPrefs) => void;
  onClose: () => void;
}) {
  return (
    <div className="border-t border-white/5 bg-black/30 px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-slate-400">Settings</h3>
        <button
          type="button"
          onClick={onClose}
          className="hud-no-drag rounded p-1 text-slate-400 hover:bg-white/5"
          aria-label="Close settings"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 space-y-2">
        <label className="block">
          <span className="text-xs text-slate-400">Global hotkey</span>
          <input
            type="text"
            value={prefs.hotkey}
            onChange={(e) => onChange({ ...prefs, hotkey: e.target.value })}
            className="mt-1 w-full rounded-md bg-white/5 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-ergora-amber/60"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Project ID (optional override)</span>
          <input
            type="text"
            value={prefs.projectId}
            onChange={(e) => onChange({ ...prefs, projectId: e.target.value })}
            placeholder="uuid"
            className="mt-1 w-full rounded-md bg-white/5 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-ergora-amber/60"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.ttsEnabled}
            onChange={(e) => onChange({ ...prefs, ttsEnabled: e.target.checked })}
          />
          <span className="text-xs text-slate-300">Speak chat replies aloud</span>
        </label>
      </div>
    </div>
  );
}
