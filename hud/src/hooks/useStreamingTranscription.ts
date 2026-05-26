// Live transcription — JS side.
//
// REWRITTEN 2026-05-26: this used to drive a MediaRecorder → Rust streaming
// pipe → /api/transcribe/stream → Google STT, but every step in that chain
// had real-world failure modes (WKWebView MediaRecorder framing, Rust
// duplex-pipe timing, Google STT mis-finalising the first chunk). The
// Ergora portal solved the same problem by just using the browser's built-in
// `webkitSpeechRecognition` — instant interim words, zero round-trips,
// proven to work in WebKit. Tauri's WKWebView is the same WebKit, so we
// mirror the portal exactly.
//
// State exposed (unchanged so callers don't break):
//   • recording  — true between start() and stop()
//   • interim    — current partial hypothesis (greyed-out text)
//   • finalText  — confirmed transcript on completion
//   • level      — 0 (placeholder; the visual pulse was removed in the
//                  redesign and callers no longer read this, but the field
//                  stays for API stability)
//   • error      — non-null if SR isn't available or permission denied
//
// macOS: requires `NSSpeechRecognitionUsageDescription` (already in
// src-tauri/Info.plist). User grants on first run via the system dialog.
// Linux (webkit2gtk): SpeechRecognition support is patchy; if it's
// unavailable, start() returns false and the caller falls back to the
// MediaRecorder→/api/transcribe path that's still in useRecorder.ts.

import { useCallback, useRef, useState } from 'react';
import { info as logInfo, error as logError } from '@tauri-apps/plugin-log';
import type { ErgoraConfig } from '../lib/config';
import { transcribe } from '../lib/api';

export interface StreamingOptions {
  /** Kept for API compat — no longer enforced; the browser SR engine
   * decides when to auto-finalise. */
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
  start: (cfg: ErgoraConfig) => Promise<boolean>;
  stop: () => Promise<string>;
  reset: () => void;
}

// Minimal subset of the spec types — DOM lib types for SpeechRecognition
// aren't always present in TS configs, so we shape them ourselves.
type SRResultItem = { transcript: string };
type SRResult = { isFinal: boolean; 0: SRResultItem } & { [k: number]: SRResultItem };
type SREvent = { results: ArrayLike<SRResult> };
type SRErrorEvent = { error?: string };
type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getSRCtor(): { new (): SR } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: { new (): SR };
    webkitSpeechRecognition?: { new (): SR };
  };
  return (w.SpeechRecognition || w.webkitSpeechRecognition) ?? null;
}

export function useStreamingTranscription(_opts: StreamingOptions = {}): StreamingHandle {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const [finalText, setFinalText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SR | null>(null);
  const latestRef = useRef<string>(''); // running combined transcript
  const finalResolveRef = useRef<((v: string) => void) | null>(null);

  // MediaRecorder fallback state (Linux/Windows where webkitSpeechRecognition
  // is unavailable). We accumulate chunks while recording and POST the whole
  // blob to /api/transcribe on stop. No interim words, just final text.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fallbackResolveRef = useRef<((v: string) => void) | null>(null);
  const fallbackCfgRef = useRef<ErgoraConfig | null>(null);

  const reset = useCallback(() => {
    setInterim('');
    setFinalText('');
    setError(null);
    latestRef.current = '';
  }, []);

  const stopFallback = useCallback(async (): Promise<string> => {
    const mr = recorderRef.current;
    if (!mr || mr.state === 'inactive') {
      // Nothing recording — return whatever we already produced.
      return latestRef.current;
    }
    return new Promise<string>((resolve) => {
      fallbackResolveRef.current = resolve;
      mr.stop(); // triggers ondataavailable + onstop below
    });
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    // SpeechRecognition path
    const rec = recognitionRef.current;
    if (rec) {
      return new Promise<string>((resolve) => {
        finalResolveRef.current = resolve;
        // .stop() lets the final result fire one last `onresult` and then
        // `onend`. .abort() would drop the last partial. We want the last word.
        try {
          rec.stop();
        } catch {
          resolve(latestRef.current);
          finalResolveRef.current = null;
        }
      });
    }
    // MediaRecorder fallback path
    if (recorderRef.current) {
      return stopFallback();
    }
    // Nothing to stop — return what we have.
    return latestRef.current;
  }, [stopFallback]);

  const startFallback = useCallback(
    async (cfg: ErgoraConfig): Promise<boolean> => {
      void logInfo('[stream] webkitSpeechRecognition unavailable — using MediaRecorder fallback');
      fallbackCfgRef.current = cfg;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        const mime = (() => {
          if (typeof MediaRecorder === 'undefined') return undefined;
          if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
            return 'audio/webm;codecs=opus';
          if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
          if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
          return undefined;
        })();
        const mr = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        recorderRef.current = mr;
        chunksRef.current = [];

        mr.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        mr.onerror = (ev) => {
          const message =
            (ev as unknown as { error?: { message?: string } }).error?.message ??
            'record error';
          void logError(`[stream:fallback] MediaRecorder error: ${message}`);
          setError(message);
          setRecording(false);
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          recorderRef.current = null;
          if (fallbackResolveRef.current) {
            fallbackResolveRef.current('');
            fallbackResolveRef.current = null;
          }
        };
        mr.onstop = async () => {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          const blob = new Blob(chunksRef.current, {
            type: mr.mimeType || 'audio/webm',
          });
          chunksRef.current = [];
          recorderRef.current = null;
          setRecording(false);
          const usedCfg = fallbackCfgRef.current;
          fallbackCfgRef.current = null;
          if (!usedCfg || blob.size === 0) {
            const result = latestRef.current;
            if (fallbackResolveRef.current) {
              fallbackResolveRef.current(result);
              fallbackResolveRef.current = null;
            }
            return;
          }
          void logInfo(`[stream:fallback] posting ${blob.size} bytes to /api/transcribe`);
          try {
            const r = await transcribe(usedCfg, blob);
            const text = r.text || '';
            latestRef.current = text;
            setFinalText(text);
            if (fallbackResolveRef.current) {
              fallbackResolveRef.current(text);
              fallbackResolveRef.current = null;
            }
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            void logError(`[stream:fallback] /api/transcribe failed: ${msg}`);
            setError(msg);
            if (fallbackResolveRef.current) {
              fallbackResolveRef.current('');
              fallbackResolveRef.current = null;
            }
          }
        };

        // Single timeslice — no interim transcripts, we just want one blob on stop.
        mr.start();
        setRecording(true);
        return true;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        void logError(`[stream:fallback] start failed: ${msg}`);
        setError(msg);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return false;
      }
    },
    [],
  );

  const start = useCallback(
    async (cfg: ErgoraConfig): Promise<boolean> => {
      reset();
      const SRCtor = getSRCtor();
      // Linux (webkit2gtk) and most WebView2 builds don't expose
      // webkitSpeechRecognition — fall back to record-blob → /api/transcribe.
      if (!SRCtor) {
        return startFallback(cfg);
      }
      try {
        const rec = new SRCtor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-GB';

        rec.onresult = (event) => {
          let allFinal = '';
          let interimText = '';
          for (let i = 0; i < event.results.length; i++) {
            const r = event.results[i];
            if (r.isFinal) allFinal += r[0].transcript + ' ';
            else interimText += r[0].transcript;
          }
          const combined = (allFinal + interimText).replace(/\s+/g, ' ').trimEnd();
          latestRef.current = combined;
          setInterim(combined);
        };

        rec.onerror = (e) => {
          const code = e?.error ?? 'unknown';
          void logError(`[stream] SpeechRecognition error: ${code}`);

          // Soft errors that don't end the session — just record + continue.
          if (code === 'no-speech') return;

          // Everything else is terminal. WKWebView doesn't reliably fire
          // `onend` after `onerror` on macOS, so we have to do the teardown
          // ourselves or the UI stays stuck in "Listening…" with dead
          // buttons.
          if (code === 'not-allowed' || code === 'service-not-allowed') {
            setError(
              'Permission denied. Open System Settings → Privacy & Security → Speech Recognition and turn on Ergora Remote (also check Microphone).',
            );
          } else if (code !== 'aborted') {
            setError(`Speech recognition error: ${code}`);
          }

          // Hard teardown.
          try {
            rec.abort();
          } catch {
            /* already gone */
          }
          recognitionRef.current = null;
          setRecording(false);
          if (finalResolveRef.current) {
            finalResolveRef.current(latestRef.current);
            finalResolveRef.current = null;
          }
        };

        rec.onend = () => {
          void logInfo(`[stream] SpeechRecognition onend — final="${latestRef.current}"`);
          setRecording(false);
          // Promote the running latest into finalText so the App can read it
          // off either field.
          setFinalText(latestRef.current);
          recognitionRef.current = null;
          if (finalResolveRef.current) {
            finalResolveRef.current(latestRef.current);
            finalResolveRef.current = null;
          }
        };

        void logInfo('[stream] starting webkitSpeechRecognition');
        rec.start();
        recognitionRef.current = rec;
        setRecording(true);
        return true;
      } catch (err) {
        void logError(`[stream] start failed: ${(err as Error).message}`);
        setError((err as Error).message);
        return false;
      }
    },
    [reset, startFallback],
  );

  return {
    recording,
    interim,
    finalText,
    level: 0,
    error,
    start,
    stop,
    reset,
  };
}
