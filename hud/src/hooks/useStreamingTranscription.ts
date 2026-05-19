// Live streaming transcription, JS side.
//
// Pairs with `src-tauri/src/transcription.rs`. The hook owns:
//   • A MediaRecorder feeding webm/opus chunks to Rust as they arrive.
//   • An AnalyserNode for the mic-level pulse and silence-triggered stop.
//   • Tauri event listeners for `transcribe-partial` / `transcribe-final` /
//     `transcribe-error` so the React layer can render words live.
//
// State exposed:
//   • `recording`         — true between start() and stop()
//   • `interim`           — most recent partial hypothesis (greyed-out text)
//   • `final` / `result`  — confirmed transcript on completion
//   • `level`             — 0..1 mic level for the visual pulse
//
// Notes:
//   • If the Rust side returns an error opening the stream, we fall back to
//     buffer-the-whole-thing-and-POST behaviour at the call site (the App
//     keeps the legacy useRecorder around).
//   • `start()` requires the Ergora cloud config — it reads agentToken +
//     apiUrl off the passed-in `ErgoraConfig`.
//   • Auto-stops after `silenceMs` of continuous silence below
//     `silenceThreshold` (RMS), or after `maxMs` total recording.

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ErgoraConfig } from '../lib/config';

export interface StreamingOptions {
  silenceMs?: number;
  silenceThreshold?: number;
  maxMs?: number;
}

export interface StreamingHandle {
  recording: boolean;
  interim: string;
  finalText: string;
  level: number;
  error: string | null;
  start: (cfg: ErgoraConfig) => Promise<boolean>; // resolves true if stream opened, false on fallback
  stop: () => Promise<string>; // returns the final transcript
  reset: () => void;
}

interface PartialPayload {
  sessionId: string;
  text: string;
}

interface ErrorPayload {
  sessionId: string;
  error: string;
}

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMimeType(): string {
  for (const mt of PREFERRED_MIME_TYPES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) {
      return mt;
    }
  }
  return 'audio/webm';
}

export function useStreamingTranscription(opts: StreamingOptions = {}): StreamingHandle {
  // 2500ms, not 1200: a 1.2s window cut the user off on a natural mid-thought
  // pause, and snapped the HUD shut almost immediately if they hadn't started
  // speaking yet. 2.5s leaves room to think without feeling laggy.
  const { silenceMs = 2500, silenceThreshold = 0.012, maxMs = 30_000 } = opts;

  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const [finalText, setFinalText] = useState('');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const finalResolveRef = useRef<((v: string) => void) | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const stopGuardRef = useRef(false);
  // Stable refs holding the most recent text — needed because the silence
  // detector and the SSE error listener both read these from stale closures.
  const interimRef = useRef('');
  const finalRef = useRef('');

  const teardownAudio = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    silenceStartRef.current = null;
    setLevel(0);
  }, []);

  const detachListeners = useCallback(() => {
    for (const u of unlistenersRef.current) {
      try {
        u();
      } catch {
        /* listener already torn down */
      }
    }
    unlistenersRef.current = [];
  }, []);

  const reset = useCallback(() => {
    setInterim('');
    setFinalText('');
    setError(null);
    interimRef.current = '';
    finalRef.current = '';
  }, []);

  // Mirror state to refs so off-render callers (silence loop, SSE listeners)
  // always see the latest value.
  useEffect(() => {
    interimRef.current = interim;
  }, [interim]);
  useEffect(() => {
    finalRef.current = finalText;
  }, [finalText]);

  const stop = useCallback(async (): Promise<string> => {
    if (stopGuardRef.current) return finalRef.current || interimRef.current;
    stopGuardRef.current = true;

    return new Promise<string>((resolve) => {
      finalResolveRef.current = resolve;
      const rec = recorderRef.current;
      const sid = sessionRef.current;

      if (rec && rec.state !== 'inactive') {
        rec.stop();
      } else {
        // No active recorder — just resolve with whatever we have.
        resolve(finalRef.current || interimRef.current || '');
        finalResolveRef.current = null;
      }

      // Tell Rust to flush the stream. Independent of MediaRecorder.onstop so
      // the final SSE event still arrives even if the recorder never fired.
      if (sid) {
        invoke('stop_transcription_stream', { sessionId: sid }).catch((err) => {
          console.warn('[stream] stop failed', err);
        });
      }

      // Safety net — if the server never emits `final`, resolve after 5s
      // with the latest interim.
      setTimeout(() => {
        if (finalResolveRef.current) {
          const fallback = finalRef.current || interimRef.current || '';
          finalResolveRef.current(fallback);
          finalResolveRef.current = null;
        }
      }, 5000);
    });
  }, []);

  const tickAnalyser = useCallback(() => {
    const an = analyserRef.current;
    if (!an) return;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    setLevel(Math.min(1, rms * 4));

    const now = performance.now();
    if (rms < silenceThreshold) {
      if (silenceStartRef.current === null) silenceStartRef.current = now;
      else if (now - silenceStartRef.current > silenceMs) {
        void stop();
        return;
      }
    } else {
      silenceStartRef.current = null;
    }

    if (now - startedAtRef.current > maxMs) {
      void stop();
      return;
    }

    rafRef.current = requestAnimationFrame(tickAnalyser);
  }, [silenceMs, silenceThreshold, maxMs, stop]);

  const start = useCallback(
    async (cfg: ErgoraConfig): Promise<boolean> => {
      reset();
      stopGuardRef.current = false;

      // Acquire mic.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        setError((err as Error).message || 'mic permission denied');
        return false;
      }
      streamRef.current = stream;

      // Audio analyser for level + silence detection.
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mimeType = pickMimeType();

      // Open the Rust streaming session. If this fails (e.g. cloud
      // unreachable), bail out — caller falls back to whole-blob transcribe.
      let sessionId: string;
      try {
        sessionId = await invoke<string>('start_transcription_stream', {
          apiUrl: cfg.apiUrl,
          authToken: cfg.agentToken,
          mimeType,
        });
      } catch (err) {
        setError(`stream open failed: ${(err as Error).message ?? err}`);
        teardownAudio();
        return false;
      }
      sessionRef.current = sessionId;

      // Listen for partial / final events scoped to this session.
      const partialUnlisten = await listen<PartialPayload>('transcribe-partial', (e) => {
        if (e.payload.sessionId !== sessionId) return;
        setInterim(e.payload.text);
      });
      const finalUnlisten = await listen<PartialPayload>('transcribe-final', (e) => {
        if (e.payload.sessionId !== sessionId) return;
        setFinalText(e.payload.text);
        setInterim('');
        if (finalResolveRef.current) {
          finalResolveRef.current(e.payload.text);
          finalResolveRef.current = null;
        }
        // Final received — detach to avoid leaking listeners across
        // start/stop cycles within the same window lifetime.
        detachListeners();
        sessionRef.current = null;
      });
      const errorUnlisten = await listen<ErrorPayload>('transcribe-error', (e) => {
        if (e.payload.sessionId !== sessionId) return;
        setError(e.payload.error);
        // Treat errors as terminal — resolve with whatever we have.
        if (finalResolveRef.current) {
          finalResolveRef.current(finalRef.current || interimRef.current || '');
          finalResolveRef.current = null;
        }
        detachListeners();
        sessionRef.current = null;
      });
      unlistenersRef.current = [partialUnlisten, finalUnlisten, errorUnlisten];

      // Wire MediaRecorder → Rust chunk stream.
      const supported = MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType: supported });
      recorderRef.current = rec;
      rec.ondataavailable = async (e) => {
        if (!e.data || e.data.size === 0) return;
        const sid = sessionRef.current;
        if (!sid) return;
        try {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          // Tauri serialises Vec<u8> as a number array; ArrayBuffer-style
          // transfer goes through `Array.from` here. The cost is negligible
          // for 250ms / ~3-5KB Opus frames.
          await invoke('push_audio_chunk', {
            sessionId: sid,
            chunk: Array.from(buf),
          });
        } catch (err) {
          console.warn('[stream] chunk push failed', err);
        }
      };
      rec.onstop = () => {
        teardownAudio();
        setRecording(false);
        // Listeners stay attached briefly so the trailing `final` SSE event
        // still resolves stop()'s promise. They're torn down on session
        // completion / error / unmount.
      };
      rec.onerror = (ev) => {
        const message =
          (ev as unknown as { error?: { message?: string } }).error?.message ?? 'record error';
        setError(message);
        teardownAudio();
        setRecording(false);
        if (finalResolveRef.current) {
          finalResolveRef.current(interimRef.current || finalRef.current || '');
          finalResolveRef.current = null;
        }
      };

      startedAtRef.current = performance.now();
      silenceStartRef.current = null;
      rec.start(250);
      setRecording(true);
      rafRef.current = requestAnimationFrame(tickAnalyser);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reset, teardownAudio, tickAnalyser],
  );

  // Detach listeners + drop any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      const sid = sessionRef.current;
      if (sid) {
        invoke('stop_transcription_stream', { sessionId: sid }).catch(() => {});
      }
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch {
          // already stopped
        }
      }
      teardownAudio();
      detachListeners();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { recording, interim, finalText, level, error, start, stop, reset };
}
