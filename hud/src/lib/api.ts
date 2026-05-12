// Calls the Ergora cloud — transcription, intent dispatch, TTS.
//
// We use Tauri's HTTP plugin (which proxies through Rust to bypass CORS) so
// the HUD can hit ergora.cloud directly without standing up a webview-side
// fetch shim. When MOCK_VOICE=1, every call returns a canned response so the
// UI iterates offline.

import { fetch } from '@tauri-apps/plugin-http';
import type { ErgoraConfig } from './config';

const MOCK = (import.meta as { env?: Record<string, string> }).env?.VITE_MOCK_VOICE === '1';

export interface TranscribeResult {
  text: string;
  backend: string;
  confidence?: number;
}

export interface VoiceResponseChat {
  ok: true;
  action: 'chat';
  forwardTo: string;
  payload: { message: string; projectId: string };
  spoken?: string;
  replyText?: string;
}

export interface VoiceResponseFindFile {
  ok: true;
  action: 'find-file';
  requestId: string;
  spoken: string;
  matches?: { path: string; deviceName?: string }[];
}

export interface VoiceResponseCapture {
  ok: true;
  action: 'capture-to-brain';
  slice: string;
  spoken: string;
}

export interface VoiceResponseOpenTool {
  ok: true;
  action: 'open-tool';
  toolId: string;
  toolName: string;
  requestId: string;
  spoken: string;
}

export interface VoiceResponseRunTask {
  ok: true;
  action: 'run-task';
  taskId?: string;
  taskName?: string;
  matches?: { id: string; name: string }[];
  spoken: string;
}

export interface VoiceResponseRunTaskDisambiguate {
  ok: true;
  action: 'run-task-disambiguate';
  matches: { id: string; name: string }[];
  spoken: string;
}

export interface VoiceResponseError {
  ok: false;
  error: string;
}

export type VoiceResponse =
  | VoiceResponseChat
  | VoiceResponseFindFile
  | VoiceResponseCapture
  | VoiceResponseOpenTool
  | VoiceResponseRunTask
  | VoiceResponseRunTaskDisambiguate
  | VoiceResponseError;

function authHeaders(cfg: ErgoraConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.agentToken}` };
}

/** POST audio (webm/opus) to /api/transcribe. */
export async function transcribe(cfg: ErgoraConfig, blob: Blob): Promise<TranscribeResult> {
  if (MOCK) {
    return { text: 'find Q2 budget on my home Mac', backend: 'mock', confidence: 0.99 };
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  const boundary = `----ergora${Math.random().toString(36).slice(2)}`;
  const ct = blob.type || 'audio/webm';
  const head = new TextEncoder().encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="capture.webm"\r\n` +
      `Content-Type: ${ct}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + buf.length + tail.length);
  body.set(head, 0);
  body.set(buf, head.length);
  body.set(tail, head.length + buf.length);

  const res = await fetch(`${cfg.apiUrl}/api/transcribe`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`transcribe failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TranscribeResult;
}

/** POST text to /api/voice for intent classification + dispatch. */
export async function dispatchVoice(
  cfg: ErgoraConfig,
  text: string,
  projectId: string,
): Promise<VoiceResponse> {
  if (MOCK) {
    return mockResponse(text, projectId);
  }
  const res = await fetch(`${cfg.apiUrl}/api/voice`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'Content-Type': 'application/json',
    },
    body: new TextEncoder().encode(
      JSON.stringify({
        text,
        projectId,
        deviceId: cfg.deviceId,
        source: 'remote-hud',
      }),
    ),
  });
  const json = (await res.json()) as VoiceResponse;
  if (!res.ok && 'ok' in json && !json.ok) return json;
  if (!res.ok) {
    return { ok: false, error: `voice dispatch failed (${res.status})` };
  }
  return json;
}

/** Stream a chat reply back from /api/chat (used when intent === chat). */
export async function chatComplete(
  cfg: ErgoraConfig,
  message: string,
  projectId: string,
): Promise<{ replyText: string }> {
  if (MOCK) {
    return { replyText: `Mock reply to: ${message}` };
  }
  const res = await fetch(`${cfg.apiUrl}/api/chat`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'Content-Type': 'application/json',
    },
    body: new TextEncoder().encode(
      JSON.stringify({ message, projectId, source: 'remote-hud' }),
    ),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`chat failed (${res.status}): ${text}`);
  }
  // /api/chat may stream SSE in production; for the HUD we accept either a
  // JSON envelope or a plain text body and treat the result as the spoken reply.
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = (await res.json()) as { reply?: string; replyText?: string; text?: string };
    return { replyText: j.replyText ?? j.reply ?? j.text ?? '' };
  }
  return { replyText: await res.text() };
}

/** Pull TTS audio from /api/tts (Neural2-J on the cloud side). */
export async function synthesize(cfg: ErgoraConfig, text: string): Promise<Blob> {
  if (MOCK) {
    return new Blob([], { type: 'audio/mpeg' });
  }
  const res = await fetch(`${cfg.apiUrl}/api/tts`, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'Content-Type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify({ text })),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`tts failed (${res.status}): ${t}`);
  }
  const data = await res.arrayBuffer();
  return new Blob([data], { type: res.headers.get('content-type') ?? 'audio/mpeg' });
}

// ── Offline-dev mock dispatcher ─────────────────────────────────────────────

function mockResponse(text: string, projectId: string): VoiceResponse {
  const t = text.toLowerCase();
  if (/^note|^capture|^remember/i.test(text)) {
    return {
      ok: true,
      action: 'capture-to-brain',
      slice: 'history',
      spoken: 'Captured to history.',
    };
  }
  if (/^find|^where is|^search/i.test(text)) {
    return {
      ok: true,
      action: 'find-file',
      requestId: 'mock-req-1',
      spoken: `Searching your devices for "${text}".`,
      matches: [
        { path: '/Users/you/Documents/Q2-budget.xlsx', deviceName: 'Home Mac' },
        { path: '/Users/you/Drive/Finance/Q2-budget-final.xlsx', deviceName: 'Work Mac' },
      ],
    };
  }
  if (/^open|^launch|^switch/i.test(text)) {
    return {
      ok: true,
      action: 'open-tool',
      toolId: 'vendor-comparison',
      toolName: 'Vendor Comparison',
      requestId: 'mock-req-2',
      spoken: 'Opening Vendor Comparison.',
    };
  }
  if (/^run|^trigger|^kick off/i.test(text)) {
    return {
      ok: true,
      action: 'run-task',
      taskId: 'mock-task-1',
      taskName: 'Abandoned cart recovery',
      spoken: 'Running Abandoned cart recovery.',
    };
  }
  void t; void projectId;
  return {
    ok: true,
    action: 'chat',
    forwardTo: '/api/chat',
    payload: { message: text, projectId },
    replyText:
      "I hear you. (This is the mock chat response — wire up cloud or unset MOCK_VOICE to talk to your actual Intern.)",
  };
}
