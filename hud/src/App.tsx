// Ergora HUD — minimal top-of-screen voice + keyboard overlay.
//
// Three window states (driven by the Rust `set_hud_size` command):
//   • pill       — idle. ~220px. Mic affordance + one-line hint, or in
//                  keyboard mode a minimal text field.
//   • recording  — ~420px. Live interim transcript + cancel (✕) / finish (✓).
//   • panel      — ~340x360. The notepad: history + long agent responses.
//
// Flow:
//   1. Hotkey or tray click → Rust shows the window → React mounts as a pill.
//   2. Default is mic mode. Click mic / press hotkey again → start recording,
//      pill widens to `recording`.
//   3. ✓ (or tap-mic, or silence) stops → POST audio to /api/transcribe.
//   4. Transcribed text → POST to /api/voice → render the per-intent result.
//      Short results stay in the pill; long ones expand into the notepad.
//   5. Esc / blur / explicit dismiss → window hides (Rust side).
//
// Networking lives in lib/api.ts; media plumbing in hooks/useRecorder.ts and
// hooks/useStreamingTranscription.ts — this component is the state machine.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, Keyboard, Mic, Send, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
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

// The four user-facing HUD views, smallest → largest. A response drops in
// underneath the pill (`pill-wide`); a long one or the history list uses the
// `notepad`; `notepad-wide` is the notepad at ~2x for chat-window use. The
// user can drag the corner grip between any of them.
type View = 'pill' | 'pill-wide' | 'notepad' | 'notepad-wide';

// Logical px size of each view — must mirror the constants in src-tauri/lib.rs.
// Used to seed the drag grip and to snap a free-form drag back onto the ladder.
const VIEW_SIZE: Record<View, [number, number]> = {
  pill: [220, 76],
  'pill-wide': [440, 150],
  notepad: [360, 360],
  'notepad-wide': [560, 560],
};

// Snap a dragged height onto the nearest view. The pill→pill-wide threshold
// is deliberately low (105, i.e. ~29px of drag) so a small "make it a bit
// bigger" gesture commits to the expanded pill instead of springing back.
function snapView(height: number): View {
  if (height < 105) return 'pill';
  if (height < 255) return 'pill-wide';
  if (height < 460) return 'notepad';
  return 'notepad-wide';
}

// A response is "short" if it has no scrollable detail to read back — it can
// stay inline in the pill rather than forcing the notepad open.
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
  // The current HUD view on the pill → notepad-wide ladder. Set automatically
  // when a response arrives (short → pill-wide, long → notepad) and manually
  // by the chevron or the corner drag grip.
  const [view, setView] = useState<View>('pill');
  // Non-null only while the corner grip is being dragged. Holds the live
  // card size {w,h}. During a drag the OS window is parked at a fixed
  // oversized envelope and only the card inside it resizes — so the cursor
  // can't slip off the window and the gesture can't be lost.
  const [dragSize, setDragSize] = useState<{ w: number; h: number } | null>(null);

  // Surface either the confirmed final transcript or the live interim
  // hypothesis as the visible text. Final wins so the bar locks once
  // confirmed.
  const liveTranscript = transcript || stream.finalText || stream.interim;
  const recording = usingStream ? stream.recording : legacyRecorder.recording;
  // `recording` only flips true once the recorder is actually up; `phase`
  // is set to 'recording' optimistically on tap. Render off this so the
  // listening UI appears instantly.
  const liveRecording = recording || phase === 'recording';

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
      // An unconfigured HUD opens straight into pill-wide so the setup notice
      // has a proper body to render in (a bottom banner on the 76px pill
      // overflows and clips the rounded corners).
      if (status.missing.length > 0) setView('pill-wide');
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
  // While dragging, the visible view follows the live card height; otherwise
  // the explicit `view` rules. `effectiveView` drives all content rendering.
  const effectiveView: View = dragSize ? snapView(dragSize.h) : view;

  // The notepad views render the ScratchPad; pill / pill-wide render the bar.
  const showPanel = effectiveView === 'notepad' || effectiveView === 'notepad-wide';

  // The transient wide single-row bar: shown while recording or typing, but
  // only before a response exists (view still `pill`). Once a response lands
  // the view itself drives the size.
  const wantsBar =
    effectiveView === 'pill' &&
    (liveRecording ||
      phase === 'transcribing' ||
      phase === 'dispatching' ||
      mode === 'keyboard');

  useEffect(() => {
    // During a grip-drag the OS window is parked at the oversized `drag`
    // envelope; the card inside resizes instead. Otherwise the window tracks
    // the view exactly.
    if (dragSize) {
      void setSize('drag');
      return;
    }
    void setSize(wantsBar ? 'bar' : view);
  }, [dragSize, wantsBar, view, setSize]);

  // Auto-size to a response: short answers drop into `pill-wide`, longer ones
  // and errors open the `notepad`. Skips it if the user has already dragged
  // out to a bigger view than we'd pick.
  useEffect(() => {
    if (dragSize) return;
    if (error) {
      setView((v) => (v === 'pill' ? 'pill-wide' : v));
    } else if (response) {
      const target: View = isShortResponse(response) ? 'pill-wide' : 'notepad';
      setView((v) => {
        const rank: View[] = ['pill', 'pill-wide', 'notepad', 'notepad-wide'];
        return rank.indexOf(v) >= rank.indexOf(target) ? v : target;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, error]);

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
    setView('pill');
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
      // Show "Listening…" the instant the mic is tapped — before the stream
      // has even opened — so there's no dead beat where the user can't tell
      // the mic is hot. The real recorder flips `recording` true a moment
      // later once the socket / MediaRecorder is up.
      setPhase('recording');
      // Try streaming first — gives interim partials and ~300ms perceived
      // latency. If the stream can't open (cloud unreachable, missing token),
      // fall back to the legacy whole-blob recorder.
      const opened = await stream.start(config);
      if (opened) {
        setUsingStream(true);
      } else {
        setUsingStream(false);
        await legacyRecorder.start();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, recording, usingStream, stream, legacyRecorder, reset, runDispatch]);

  // ✓ — finish recording and dispatch. Same path as tapping the mic again.
  const finishRecording = useCallback(() => {
    if (recording) void toggleRecording();
  }, [recording, toggleRecording]);

  // ✕ — discard the recording and drop straight into the keyboard bar (no
  // dispatch). Mic and keyboard are two sides of one input surface: ✕ hops
  // from the mic side to the keyboard side without a pill flash in between.
  const cancelRecording = useCallback(async () => {
    // Also fire during the optimistic-listening gap (phase set, recorder not
    // yet up) so ✕ is never a dead button.
    if (!recording && phase !== 'recording') return;
    if (recording) {
      if (usingStream) {
        await stream.stop().catch(() => {});
      } else {
        await legacyRecorder.stop().catch(() => {});
      }
    }
    reset();
    setMode('keyboard');
  }, [recording, phase, usingStream, stream, legacyRecorder, reset]);

  // Hop from the keyboard bar straight into recording — no intermediate
  // collapsed-pill step. Used by the keyboard bar's mic button.
  const switchToMicAndRecord = useCallback(async () => {
    if (recording) return;
    setMode('mic');
    await toggleRecording();
  }, [recording, toggleRecording]);

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
      if (recording || phase === 'recording') return 'Listening…';
      return 'Tap to speak';
    }
    return '';
  }, [error, phase, mode, recording]);

  // The pill bar's top row has two shapes:
  //   • collapsed — the resting state. Four uniform icons, nothing else.
  //   • expanded  — a wide row with the transcript / keyboard input.
  // Responses no longer live in this row — they drop into the body below.
  const collapsed = mode === 'mic' && !liveRecording && !liveTranscript;

  // The card floats inside the (sometimes larger) window. The pill is left
  // content-sized so it stays a compact capsule; every other view is pinned to
  // an explicit height so its scroll area fills the window — otherwise the
  // notepad collapses to the natural height of its content (the "thin
  // notepad that won't stay expanded" bug).
  const cardStyle = dragSize
    ? { width: dragSize.w, height: dragSize.h }
    : effectiveView === 'pill'
      ? undefined
      : { height: VIEW_SIZE[effectiveView][1] - 4 };

  return (
    <div className="flex h-screen w-screen items-start justify-center pt-1">
      <div
        style={cardStyle}
        className={`hud-no-drag relative flex max-w-full flex-col overflow-hidden rounded-2xl border border-white/5 bg-slate-900/[0.92] shadow-hud backdrop-blur-hud animate-hud-in ${
          dragSize ? '' : 'w-full'
        }`}
      >
        {showPanel ? (
          // ── Notepad — history + long/rich responses ───────────────
          <ScratchPad
            response={error ? null : response}
            error={error}
            apiUrl={config?.apiUrl ?? 'https://ergora.cloud'}
            onCollapse={() => reset()}
            onDismiss={dismiss}
            onOpenSettings={() => setShowSettings(true)}
          />
        ) : (
          // ── Pill — idle / recording / short inline result ─────────────
          <>
            {/* Drag handle — grab the empty strip above the controls. */}
            <div className="hud-drag h-2 w-full" />

            <div className="flex h-12 items-center gap-2 px-2.5">
              {collapsed ? (
                // ── Collapsed pill — four uniform icons, nothing else ─────
                // Tap keyboard to type, mic to speak; both expand the bar.
                <div className="flex w-full items-center justify-center gap-1.5">
                  <PillIcon label="Type" onClick={() => switchMode('keyboard')}>
                    <Keyboard className="h-4 w-4" />
                  </PillIcon>
                  <PillIcon label="Speak" onClick={() => void toggleRecording()}>
                    <Mic className="h-4 w-4" />
                  </PillIcon>
                  <PillIcon label="Open notepad" onClick={() => setView('notepad')}>
                    <ChevronDown className="h-4 w-4" />
                  </PillIcon>
                  <PillIcon label="Dismiss" onClick={dismiss}>
                    <X className="h-4 w-4" />
                  </PillIcon>
                </div>
              ) : (
                // ── Expanded bar — transcript / keyboard input + controls ─
                // No left-hand record button: recording is started from the
                // collapsed pill's mic icon, and while recording the row is
                // just the transcript plus the cancel / finish pair.
                <>
              <div className="min-w-0 flex-1">
                {mode === 'keyboard' ? (
                  <KeyboardInput
                    value={keyboardText}
                    onChange={setKeyboardText}
                    onSubmit={submitKeyboard}
                    busy={phase === 'transcribing' || phase === 'dispatching'}
                  />
                ) : liveRecording || liveTranscript ? (
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
                ) : (
                  <div className="truncate text-[13px] text-slate-400">
                    {hint || 'Tap to speak'}
                  </div>
                )}
              </div>

              {/* Recording — cancel (✕) / finish (✓) pair, Wispr-style. */}
              {liveRecording && mode === 'mic' ? (
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
                    className="hud-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-400"
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
                    onClick={() => {
                      // Mic side → keyboard side, and keyboard side → straight
                      // into recording. No collapsed-pill step in between.
                      if (mode === 'mic') switchMode('keyboard');
                      else void switchToMicAndRecord();
                    }}
                    aria-label={mode === 'mic' ? 'Switch to keyboard' : 'Switch to mic'}
                    className="hud-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  >
                    {mode === 'mic' ? (
                      <Keyboard className="h-3.5 w-3.5" />
                    ) : (
                      <Mic className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {/* Chevron — open the notepad. */}
                  <button
                    type="button"
                    onClick={() => setView('notepad')}
                    aria-label="Open notepad"
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
                </>
              )}
            </div>

            {/* Response body — drops in underneath the pill bar in the
                `pill-wide` view. A longer reply auto-promotes to the notepad
                (handled by the response-sizing effect above). The setup
                notice also lives here rather than as a bottom banner, which
                would overflow the 76px pill and clip its rounded corners. */}
            {effectiveView === 'pill-wide' && (
              <div className="hud-scroll min-h-0 flex-1 overflow-auto border-t border-white/5 px-3.5 py-2.5 text-[13px] leading-relaxed">
                {missingConfig.length > 0 ? (
                  <span className="text-amber-200">
                    Not configured — add{' '}
                    <code className="rounded bg-black/30 px-1 py-0.5">
                      {missingConfig.join(', ')}
                    </code>{' '}
                    to{' '}
                    <code className="rounded bg-black/30 px-1 py-0.5">
                      ~/.ergora-remote/.env
                    </code>
                    .
                  </span>
                ) : error ? (
                  <span className="text-rose-300">{error}</span>
                ) : response ? (
                  <span className="text-slate-200">
                    {!response.ok
                      ? response.error
                      : response.action === 'chat'
                        ? response.replyText ?? response.spoken ?? 'Thinking…'
                        : response.spoken}
                  </span>
                ) : (
                  <span className="text-slate-500">Waiting for a response…</span>
                )}
              </div>
            )}
          </>
        )}

        {/* Corner drag grip — pull to resize; snaps onto the four-view ladder
            (pill / pill-wide / notepad / notepad-wide) on release. */}
        {!liveRecording && (
          <ResizeGrip
            startW={dragSize ? dragSize.w : wantsBar ? 440 : VIEW_SIZE[view][0]}
            startH={dragSize ? dragSize.h : wantsBar ? 76 : VIEW_SIZE[view][1]}
            onStart={() =>
              setDragSize({
                w: wantsBar ? 440 : VIEW_SIZE[view][0],
                h: wantsBar ? 76 : VIEW_SIZE[view][1],
              })
            }
            onResize={(w, h) => setDragSize({ w, h })}
            onEnd={(h) => {
              setView(snapView(h));
              setDragSize(null);
            }}
          />
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

// A uniform icon button for the collapsed pill — all four (keyboard, mic,
// notepad, dismiss) share one size and treatment so the resting HUD reads as
// a clean row of equals rather than one accented control.
function PillIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="hud-no-drag flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-white/5 hover:text-slate-100"
    >
      {children}
    </button>
  );
}

// Bottom-right corner grip.
//
// During a drag the OS window is parked at a fixed oversized envelope and
// only the *card* (a plain DOM element) resizes — so this is just a CSS
// resize: it grows and shrinks equally well, and because the window never
// moves the cursor can't slip off it and lose the gesture.
//
// `finish` is wired to pointerup, pointercancel AND lostpointercapture, and
// guarded by `done`, so the drag is always cleanly ended exactly once — the
// HUD can never get stuck in a resizing state.
function ResizeGrip({
  startW,
  startH,
  onStart,
  onResize,
  onEnd,
}: {
  startW: number;
  startH: number;
  onStart: () => void;
  onResize: (w: number, h: number) => void;
  onEnd: (h: number) => void;
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const sx = e.screenX;
    const sy = e.screenY;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    onStart();
    let lastH = startH;
    let done = false;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const move = (ev: PointerEvent) => {
      // Card grows/shrinks centred horizontally (2px per 1px of cursor move
      // so the grip tracks the pointer) and downward vertically.
      const w = clamp(startW + (ev.screenX - sx) * 2, 220, 560);
      const h = clamp(startH + (ev.screenY - sy), 76, 560);
      lastH = h;
      onResize(w, h);
    };
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      el.removeEventListener('lostpointercapture', finish);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already released */
      }
      onEnd(lastH);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('lostpointercapture', finish);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-label="Resize HUD"
      className="hud-no-drag absolute bottom-0 right-0 z-20 flex h-5 w-5 cursor-nwse-resize items-end justify-end p-1 text-slate-600 hover:text-slate-300"
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
        <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
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
