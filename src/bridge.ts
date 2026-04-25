/**
 * bridge — talks to the Ergora cloud via authenticated HTTP.
 *
 * We don't use Supabase Realtime directly: RLS would require issuing a
 * scoped JWT to every agent, which is more surface area than we need.
 * Instead we poll /api/device/agent/heartbeat every 3s. The heartbeat
 * endpoint atomically claims any pending requests in the same call, so
 * polling doubles as both presence + work pickup.
 */
import { config } from './config.js';
import { runAgentRequest } from './agent.js';
import { FileEvent } from './watcher.js';

const API = (config.apiUrl ?? 'https://ergora.cloud').replace(/\/$/, '');

interface DeviceRequest {
  id: string;
  type: 'query' | 'task';
  payload: { prompt: string; context?: string };
  created_at: string;
}

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.agentToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

export async function registerDevice() {
  try {
    const result = await api<{ ok: boolean; user_id: string }>('/api/device/agent/register', {
      device_id: config.deviceId,
      device_name: config.deviceName,
      platform: config.platform,
      agent_version: '0.1.0',
      mounted_paths: config.mountedPaths,
      device_role: config.deviceRole,
      device_label: config.deviceLabel,
    });
    console.log(`[bridge] Device registered: ${config.deviceName} (${config.deviceId.slice(0, 8)}...)`);
    return result.ok;
  } catch (err) {
    console.error('[bridge] Registration failed:', (err as Error).message);
    return false;
  }
}

export async function deregisterDevice() {
  // Server marks devices offline after missed heartbeats; no explicit call needed.
}

export function startBridge(_onFileEventUpstream: (event: FileEvent) => Promise<void>) {
  const tick = async () => {
    if (stopping) return;
    try {
      const { pending } = await api<{ ok: boolean; pending: DeviceRequest[] }>(
        '/api/device/agent/heartbeat',
        { device_id: config.deviceId }
      );
      if (pending && pending.length > 0) {
        console.log(`[bridge] Claimed ${pending.length} request(s)`);
        // Run them in parallel but bounded by the agent's own turn limit
        await Promise.all(pending.map(handleRequest));
      }
    } catch (err) {
      console.error('[bridge] Heartbeat error:', (err as Error).message);
    }
  };

  // First tick immediately, then every 3s
  tick();
  pollTimer = setInterval(tick, 3_000);
  console.log('[bridge] Polling bridge started (every 3s)');
}

export function stopBridge() {
  stopping = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function handleRequest(req: DeviceRequest) {
  console.log(`[bridge] Running request ${req.id.slice(0, 8)} (${req.type})`);
  try {
    const result = await runAgentRequest({
      id: req.id,
      type: req.type,
      prompt: req.payload.prompt,
      context: req.payload.context,
    });
    await api('/api/device/agent/complete', {
      request_id: req.id,
      status: 'done',
      result: { answer: result.answer, tools_used: result.toolsUsed },
    });
    console.log(`[bridge] Completed ${req.id.slice(0, 8)}`);
  } catch (err) {
    await api('/api/device/agent/complete', {
      request_id: req.id,
      status: 'error',
      error: (err as Error).message,
    }).catch(() => {});
    console.error(`[bridge] Request ${req.id.slice(0, 8)} failed:`, (err as Error).message);
  }
}
