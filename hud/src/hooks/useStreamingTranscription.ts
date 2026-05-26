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

  const reset = useCallback(() => {
    setInterim('');
    setFinalText('');
    setError(null);
    latestRef.current = '';
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    const rec = recognitionRef.current;
    if (!rec) {
      // Nothing to stop — return what we have.
      return latestRef.current;
    }
    return new Promise<string>((resolve) => {
      finalResolveRef.current = resolve;
      // .stop() lets the final result fire one last `onresult` and then
      // `onend`. .abort() would drop the last partial. We want the last word.
      try {
        rec.stop();
      } catch {
        // Already stopped — resolve with current text.
        resolve(latestRef.current);
        finalResolveRef.current = null;
      }
    });
  }, []);

  const start = useCallback(
    async (_cfg: ErgoraConfig): Promise<boolean> => {
      reset();
      const SRCtor = getSRCtor();
      if (!SRCtor) {
        void logError('[stream] SpeechRecognition not available in this webview');
        setError('Speech recognition not available.');
        return false;
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
          if (code === 'not-allowed' || code === 'service-not-allowed') {
            setError('Microphone permission denied.');
          } else if (code === 'no-speech') {
            // Soft — user just hadn't said anything yet.
          } else if (code !== 'aborted') {
            setError('Speech recognition error.');
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
    [reset],
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
