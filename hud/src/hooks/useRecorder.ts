// MediaRecorder wrapper with light VAD (silence-triggered stop).
//
// Behaviour:
//   • start() begins capturing webm/opus.
//   • An AnalyserNode samples the input; if RMS drops below `silenceThreshold`
//     for `silenceMs` continuously, we auto-stop. This is the "stop talking
//     and the HUD knows you're done" UX.
//   • Manual stop() short-circuits the silence timer.
//   • The hook surfaces a `level` (0–1) for the mic-pulse animation.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RecorderOptions {
  silenceMs?: number;          // default 1200 — matches spec
  silenceThreshold?: number;   // default 0.012 — empirical for opus/webm
  maxMs?: number;              // hard cap, default 30s
  mimeType?: string;
}

export interface RecorderHandle {
  recording: boolean;
  level: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
}

export function useRecorder(opts: RecorderOptions = {}): RecorderHandle {
  const {
    silenceMs = 1200,
    silenceThreshold = 0.012,
    maxMs = 30_000,
    mimeType = 'audio/webm;codecs=opus',
  } = opts;

  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const stopResolveRef = useRef<((blob: Blob | null) => void) | null>(null);
  const autoStopRef = useRef<() => void>(() => {});

  const cleanup = useCallback(() => {
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

  const stop = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec || rec.state === 'inactive') {
        resolve(null);
        return;
      }
      stopResolveRef.current = resolve;
      rec.stop();
    });
  }, []);

  // Keep the latest auto-stop in a ref so the rAF loop's closure stays fresh.
  useEffect(() => {
    autoStopRef.current = () => {
      void stop();
    };
  }, [stop]);

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
        autoStopRef.current();
        return;
      }
    } else {
      silenceStartRef.current = null;
    }

    // Hard cap.
    if (now - startedAtRef.current > maxMs) {
      autoStopRef.current();
      return;
    }

    rafRef.current = requestAnimationFrame(tickAnalyser);
  }, [silenceMs, silenceThreshold, maxMs]);

  const start = useCallback(async () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') return;
    setError(null);
    chunksRef.current = [];

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
      return;
    }
    streamRef.current = stream;

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyserRef.current = analyser;

    const supported = MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: supported });
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: supported });
      cleanup();
      setRecording(false);
      stopResolveRef.current?.(blob);
      stopResolveRef.current = null;
    };
    rec.onerror = (e) => {
      const message = (e as unknown as { error?: { message?: string } }).error?.message ?? 'record error';
      setError(message);
      cleanup();
      setRecording(false);
      stopResolveRef.current?.(null);
      stopResolveRef.current = null;
    };

    startedAtRef.current = performance.now();
    silenceStartRef.current = null;
    rec.start(250);
    setRecording(true);
    rafRef.current = requestAnimationFrame(tickAnalyser);
  }, [cleanup, mimeType, tickAnalyser]);

  // Tear down on unmount.
  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    cleanup();
  }, [cleanup]);

  return { recording, level, error, start, stop };
}
