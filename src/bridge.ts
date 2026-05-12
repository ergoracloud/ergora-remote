/**
 * bridge — talks to the Ergora cloud via authenticated HTTP.
 *
 * We don't use Supabase Realtime directly: RLS would require issuing a
 * scoped JWT to every agent, which is more surface area than we need.
 * Instead we poll /api/device/agent/heartbeat every 3s. The heartbeat
 * endpoint atomically claims any pending requests in the same call, so
 * polling doubles as both presence + work pickup.
 *
 * Hardening v1: registration may return 202 `pending_approval` (soft-block)
 * or 403 `admin_offline_24h` (hard-reject). In the soft-block case we poll
 * /api/device/agent/status every 5s until the admin approves or rejects.
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

type RegistrationResult =
  | { ok: true }
  | { ok: false; reason: 'pending_approval' | 'rejected' | 'error'; message: string };

async function apiRaw(path: string, body?: unknown) {
  return fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.agentToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await apiRaw(path, body);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

function printBanner(message: string) {
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  ${message}`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('');
}

async function pollUntilApproved(): Promise<RegistrationResult> {
  printBanner('Waiting for approval from your admin device…');
  while (!stopping) {
    await new Promise(r => setTimeout(r, 5_000));
    try {
      const res = await apiRaw(`/api/device/agent/status?device_id=${encodeURIComponent(config.deviceId)}`);
      if (!res.ok) continue;
      const j = (await res.json()) as { status: string; reason?: string };
      if (j.status === 'active') {
        printBanner('Approved — Ergora Remote is now active.');
        return { ok: true };
      }
      if (j.status === 'rejected') {
        if (j.reason === 'admin_offline_24h') {
          return {
            ok: false,
            reason: 'rejected',
            message: 'Admin device seems to be offline. For safety we have rejected pending mobile requests.',
          };
        }
        return { ok: false, reason: 'rejected', message: 'This device was not approved.' };
      }
      // status === 'pending_approval' → keep polling
    } catch {
      // network blip — keep polling
    }
  }
  return { ok: false, reason: 'error', message: 'stopped' };
}

export async function registerDevice(): Promise<RegistrationResult> {
  try {
    const res = await apiRaw('/api/device/agent/register', {
      device_id: config.deviceId,
      device_name: config.deviceName,
      platform: config.platform,
      agent_version: '0.1.0',
      mounted_paths: config.mountedPaths,
      device_role: config.deviceRole,
      device_tag: config.deviceTag,
      device_label: config.deviceLabel,
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 202 && j.status === 'pending_approval') {
      return await pollUntilApproved();
    }
    if (res.status === 403 && j.error === 'admin_offline_24h') {
      return {
        ok: false,
        reason: 'rejected',
        message: (j.message as string) || 'Admin device seems to be offline. For safety we have rejected pending mobile requests.',
      };
    }
    if (res.status === 400 && (j.error === 'admin_tag_required' || j.error === 'device_tag_required')) {
      return {
        ok: false,
        reason: 'error',
        message: (j.message as string) || 'Tag your primary device (Home / Work / Main) before registering more devices.',
      };
    }
    if (!res.ok) {
      return { ok: false, reason: 'error', message: `register → ${res.status}` };
    }
    console.log(`[bridge] Device registered: ${config.deviceName} (${config.deviceId.slice(0, 8)}...)`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message };
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
