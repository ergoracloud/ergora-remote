import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_FILE = join(homedir(), '.ergora-local', 'state.json');

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
  const dir = join(homedir(), '.ergora-local');
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
  if (missing.length > 0) {
    console.error(`\n❌ Missing required config: ${missing.join(', ')}`);
    console.error('   Run: ergora-local setup\n');
    process.exit(1);
  }
}
