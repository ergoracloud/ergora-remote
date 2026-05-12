import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_FILE = join(homedir(), '.ergora-remote', 'state.json');

// Device role helps the agent (and your Intern back in the cloud) reason
// about which device to use for a given task — "find the doc on my home Mac"
// vs "open my work email". Stored in state.json on first run, sent up to
// device_registrations so the portal + agent know.
export type DeviceRole = 'home' | 'work' | 'laptop' | 'studio' | 'server' | 'other';

// device_tag is the trust tier used by the v1 abuse-hardening flow:
//   admin tier: home / work / main → max 2, always-active authoriser
//   mobile tier: laptop / travel_laptop → max 3, subject to approval
// Distinct from deviceRole (which is AI-routing only).
export type DeviceTag = 'home' | 'work' | 'main' | 'laptop' | 'travel_laptop';

interface AgentState {
  deviceId: string;
  deviceName: string;
  platform: string;
  deviceRole?: DeviceRole;
  deviceTag?: DeviceTag;
  deviceLabel?: string; // free-text label, e.g. "Tom's MacBook Pro 16"
}

function loadOrCreateState(): AgentState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  // Allow first-run env overrides — the install script can pass these so
  // there's no interactive prompt. Otherwise we set role on first heartbeat
  // via the portal UI.
  const envRole = (process.env.DEVICE_ROLE || '').toLowerCase() as DeviceRole;
  const validRoles: DeviceRole[] = ['home', 'work', 'laptop', 'studio', 'server', 'other'];
  const role = validRoles.includes(envRole) ? envRole : undefined;

  const envTag = (process.env.DEVICE_TAG || '').toLowerCase() as DeviceTag;
  const validTags: DeviceTag[] = ['home', 'work', 'main', 'laptop', 'travel_laptop'];
  const tag = validTags.includes(envTag) ? envTag : undefined;

  const state: AgentState = {
    deviceId: randomUUID(),
    deviceName: process.env.DEVICE_NAME ?? require('os').hostname(),
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    deviceRole: role,
    deviceTag: tag,
    deviceLabel: process.env.DEVICE_LABEL || undefined,
  };
  const dir = join(homedir(), '.ergora-remote');
  if (!existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

const state = loadOrCreateState();

export const config = {
  agentToken:    process.env.ERGORA_AGENT_TOKEN ?? '',
  anthropicKey:  process.env.ANTHROPIC_API_KEY ?? '',
  apiUrl:        process.env.ERGORA_API_URL ?? 'https://ergora.cloud',
  deviceId:      state.deviceId,
  deviceName:    state.deviceName,
  platform:      state.platform as 'macos' | 'windows' | 'linux',
  deviceRole:    state.deviceRole,
  deviceTag:     state.deviceTag,
  deviceLabel:   state.deviceLabel,
  mountedPaths:  (process.env.MOUNTED_PATHS ?? '').split(',').map(p => p.trim()).filter(Boolean),
};

export function validateConfig() {
  const missing: string[] = [];
  if (!config.agentToken)   missing.push('ERGORA_AGENT_TOKEN');
  if (!config.anthropicKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length === 0) return;

  console.error('\n────────────────────────────────────────────────────────────');
  console.error('   Ergora Remote — setup needed');
  console.error('────────────────────────────────────────────────────────────\n');

  if (missing.includes('ERGORA_AGENT_TOKEN')) {
    console.error('  ❌ ERGORA_AGENT_TOKEN is not set.');
    console.error('');
    console.error('     Ergora Remote needs an active subscription ($29 USD/mo).');
    console.error('');
    console.error('     • New here?  → https://ergora.app/remote');
    console.error('     • Already a customer? Get your token:');
    console.error('       https://ergora.cloud/portal  →  Cmd+K  →  "Ergora Remote"');
    console.error('');
    console.error('     Then add the token to .env:');
    console.error('       ERGORA_AGENT_TOKEN=eal_xxxxxxxxxxxx');
    console.error('');
  }
  if (missing.includes('ANTHROPIC_API_KEY')) {
    console.error('  ❌ ANTHROPIC_API_KEY is not set.');
    console.error('     Get one at https://console.anthropic.com → API keys');
    console.error('     Then add to .env: ANTHROPIC_API_KEY=sk-ant-...');
    console.error('');
  }

  console.error('────────────────────────────────────────────────────────────\n');
  process.exit(1);
}
