import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_FILE = join(homedir(), '.ergora-remote', 'state.json');

interface AgentState {
  deviceId: string;
  deviceName: string;
  platform: string;
}

function loadOrCreateState(): AgentState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  const state: AgentState = {
    deviceId: randomUUID(),
    deviceName: process.env.DEVICE_NAME ?? require('os').hostname(),
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
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
