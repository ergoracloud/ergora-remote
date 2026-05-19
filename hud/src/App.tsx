// Ergora HUD — minimal top-of-screen voice + keyboard overlay.
//
// Three window states (driven by the Rust `set_hud_size` command):
//   • pill       — idle. ~220px. Mic affordance + one-line hint, or in
//                  keyboard mode a minimal text field.
//   • recording  — ~420px. Live interim transcript + cancel (✕) / finish (✓).
//   • panel      — ~340x360. The scratch pad: history + long agent responses.
//
// Flow:
//   1. Hotkey or tray click → Rust shows the window → React mounts as a pill.
//   2. Default is mic mode. Click mic / press hotkey again → start recording,
//      pill widens to `recording`.
//   3. ✓ (or tap-mic, or silence) stops → POST audio to /api/transcribe.
//   4. Transcribed text → POST to /api/voice → render the per-intent result.
//      Short results stay in the pill; long ones expand into the scratch pad.
//   5. Esc / blur / explicit dismiss → window hides (Rust side).
//
// Networking lives in lib/api.ts; media plumbing in hooks/useRecorder.ts and
// hooks/useStreamingTranscription.ts — this component is the state machine.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Keyboard, Mic, Send, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MicButton } from './components/MicButton';
import { KeyboardInput } from './components/KeyboardInput';
import { ScratchPad } from './components/ScratchPad';
import { useRecorder } from './hooks/useRecorder';
import { useStreamingTranscription } from './hooks/useStreamingTranscription';
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

// A response is "short" if it has no scrollable detail to read back — it can
// stay inline in the pill rather than forcing the scratch pad open.
function isShortResponse(r: VoiceResponse | null): boolean {
  if (!r || !r.ok) return false;
  switch (r.action) {
    case 'capture-to-brain':
    case 'open-tool':
    case 'run-task':
      return true;
    case 'chat':
      // A chat reply is short only while it's still pending or genuinely brief.
      return !r.replyText || r.replyText.length <= 140;
    case 'find-file':
      return (r.matches?.length ?? 0) === 0;
    case 'run-task-disambiguate':
      return false;
    default:
      return false;
  }
}

export default function App() {
  const { hide, setSize } = useHudWindow();
  // Live-streaming transcription is the primary path — interim words appear
  // as the user speaks. If the stream fails to open we fall back to the
  // whole-blob recorder (kept around as `legacyRecorder`).
  const stream = useStreamingTranscription();
  const legacyRecorder = useRecorder();

  const [mode, setMode] = useState<Mode>('mic');
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [keyboardText, setKeyboardText] = useState('');
  const [response, setResponse] = useState<VoiceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True iff the streaming path is currently driving the mic. False means we
  // fell through to the legacy whole-blob recorder.
  const [usingStream, setUsingStream] = useState(false);
  // The user explicitly opened the scratch pad (chevron). Distinct from a
  // long response auto-expanding it.
  const [padOpen, setPadOpen] = useState(false);

  // Surface either the confirmed final transcript or the live interim
  // hypothesis as the visible text. Final wins so the bar locks once
  // confirmed.
  const liveTranscript = transcript || stream.finalText || stream.interim;
  const recording = usingStream ? stream.recording : legacyRecorder.recording;
  const recorderLevel = usingStream ? stream.level : legacyRecorder.level;

  const [config, setConfig] = useState<ErgoraConfig | null>(null);
  const [missingConfig, setMissingConfig] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Boot — config + prefs ─────────────────────────────────────────────
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

  // ── Window sizing — derive the one true state and push it to Rust ──────
  // recording → `recording`; scratch pad (user-opened OR a long/rich
  // response/error) → `panel`; everything else → the idle `pill`.
  const showPanel =
    padOpen ||
    Boolean(error) ||
    (Boolean(response) && !isShortResponse(response));

  useEffect(() => {
    if (recording || phase === 'transcribing') {
      void setSize('recording');
    } else if (showPanel) {
      void setSize('panel');
    } else {
      void setSize('pill');
    }
  }, [recording, phase, showPanel, setSize]);

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
  }, [mode, recording]);

  const reset = useCallback(() => {
    setTranscript('');
    setKeyboardText('');
    setResponse(null);
    setError(null);
    setPhase('idle');
    setPadOpen(false);
    stream.reset();
  }, [stream]);

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
    if (recording) {
      // Stop whichever path is active.
      if (usingStream) {
        const finalText = await stream.stop();
        if (!finalText) {
          setPhase('idle');
          return;
        }
        setTranscript(finalText);
        await runDispatch(finalText);
      } else {
        const blob = await legacyRecorder.stop();
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
      }
    } else {
      reset();
      // Try streaming first — gives interim partials and ~300ms perceived
      // latency. If the stream can't open (cloud unreachable, missing token),
      // fall back to the legacy whole-blob recorder.
      const opened = await stream.start(config);
      if (opened) {
        setUsingStream(true);
        setPhase('recording');
      } else {
        setUsingStream(false);
        await legacyRecorder.start();
        setPhase('recording');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, recording, usingStream, stream, legacyRecorder, reset, runDispatch]);

  // ✓ — finish recording and dispatch. Same path as tapping the mic again.
  const finishRecording = useCallback(() => {
    if (recording) void toggleRecording();
  }, [recording, toggleRecording]);

  // ✕ — discard the recording and return to the idle pill, no dispatch.
  const cancelRecording = useCallback(async () => {
    if (!recording) return;
    if (usingStream) {
      await stream.stop().catch(() => {});
    } else {
      await legacyRecorder.stop().catch(() => {});
    }
    reset();
  }, [recording, usingStream, stream, legacyRecorder, reset]);

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
      if (recording) return 'Listening…';
      return 'Tap to speak';
    }
    return '';
  }, [error, phase, mode, recording]);

  // A short response that didn't open the pad — shown inline in the pill.
  const inlineResponse = response && !showPanel ? response : null;

  return (
    <div className="flex h-screen w-screen items-start justify-center pt-1">
      <div className="hud-no-drag relative flex w-full max-w-full flex-col overflow-hidden rounded-2xl border border-white/5 bg-slate-900/[0.92] shadow-hud backdrop-blur-hud animate-hud-in">
        {showPanel ? (
          // ── Scratch pad — history + long/rich responses ───────────────
          <ScratchPad
            response={error ? null : response}
            error={error}
            apiUrl={config?.apiUrl ?? 'https://ergora.cloud'}
            onCollapse={() => {
              setPadOpen(false);
              // Collapsing while a long response is showing also clears it,
              // otherwise showPanel would immediately re-open the pad.
              if (response && !isShortResponse(response)) reset();
            }}
            onDismiss={dismiss}
            onOpenSettings={() => setShowSettings(true)}
          />
        ) : (
          // ── Pill — idle / recording / short inline result ─────────────
          <>
            {/* Drag handle — grab the empty strip above the controls. */}
            <div className="hud-drag h-2 w-full" />

            <div className="flex h-12 items-center gap-2 px-2.5">
              {mode === 'mic' ? (
                <MicButton
                  recording={recording}
                  level={recorderLevel}
                  busy={phase === 'transcribing' || phase === 'dispatching'}
                  onClick={() => void toggleRecording()}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => switchMode('mic')}
                  aria-label="Switch to mic mode"
                  className="hud-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/5 text-slate-200 hover:bg-white/10"
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
                ) : recording || liveTranscript ? (
                  // Confirmed text in slate-200; live interim greyed out.
                  <div className="truncate text-[13px]">
                    {transcript || stream.finalText ? (
                      <span className="text-slate-200">{transcript || stream.finalText}</span>
                    ) : stream.interim ? (
                      <span className="text-slate-400">{stream.interim}</span>
                    ) : (
                      <span className="text-slate-400">{hint}</span>
                    )}
                  </div>
                ) : inlineResponse ? (
                  // Short response folded inline — no pad needed.
                  <div className="truncate text-[13px] text-slate-200">
                    {!inlineResponse.ok
                      ? inlineResponse.error
                      : inlineResponse.action === 'chat'
                        ? inlineResponse.replyText ?? inlineResponse.spoken ?? 'Thinking…'
                        : inlineResponse.spoken}
                  </div>
                ) : (
                  <div className="truncate text-[13px] text-slate-400">
                    {hint || 'Tap to speak'}
                  </div>
                )}
              </div>

              {/* Recording — cancel (✕) / finish (✓) pair, Wispr-style. */}
              {recording && mode === 'mic' ? (
                <>
                  <button
                    type="button"
                    onClick={() => void cancelRecording()}
                    aria-label="Discard"
                    className="hud-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-rose-500/15 hover:text-rose-300"
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={finishRecording}
                    aria-label="Finish and send"
                    className="hud-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ergora-amber text-slate-900 hover:bg-ergora-amber/90"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                </>
              ) : (
                // Idle controls — small, icon-only so they fit the pill.
                <>
                  {mode === 'keyboard' && (
                    <button
                      type="button"
                      onClick={() => void submitKeyboard()}
                      aria-label="Send"
                      disabled={!keyboardText.trim()}
                      className="hud-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => switchMode(mode === 'mic' ? 'keyboard' : 'mic')}
                    aria-label={mode === 'mic' ? 'Switch to keyboard' : 'Switch to mic'}
                    className="hud-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  >
                    {mode === 'mic' ? (
                      <Keyboard className="h-3.5 w-3.5" />
                    ) : (
                      <Mic className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {/* Chevron — open the scratch pad. */}
                  <button
                    type="button"
                    onClick={() => setPadOpen(true)}
                    aria-label="Open scratch pad"
                    className="hud-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={dismiss}
                    aria-label="Dismiss"
                    className="hud-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>

            {missingConfig.length > 0 && (
              <div className="border-t border-white/5 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                Not configured — add{' '}
                <code className="rounded bg-black/30 px-1 py-0.5">{missingConfig.join(', ')}</code>{' '}
                to <code className="rounded bg-black/30 px-1 py-0.5">~/.ergora-remote/.env</code>.
              </div>
            )}
          </>
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
