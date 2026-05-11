import { validateConfig, config } from './config.js';
import { registerDevice, deregisterDevice, startBridge, stopBridge } from './bridge.js';
import { startWatcher, onFileEvent, stopWatcher } from './watcher.js';
import { enqueueFileEvent } from './sync.js';
import { extname } from 'path';

const VERSION = '0.1.0';

const NOTABLE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv',
  '.md', '.txt', '.msg', '.eml',
]);

async function main() {
  console.log(`\n🔵 Ergora Desktop Agent v${VERSION}`);
  console.log(`   Device: ${config.deviceName} (${config.platform})`);
  console.log(`   ID:     ${config.deviceId.slice(0, 8)}...`);
  if (config.mountedPaths.length > 0) {
    console.log(`   Paths:  ${config.mountedPaths.join(', ')}`);
  } else {
    console.log(`   Paths:  None configured (set MOUNTED_PATHS in .env)`);
  }
  console.log('');

  validateConfig();

  // Register device with Ergora cloud. May soft-block waiting for admin
  // approval (handled inside registerDevice) or hard-reject after 24h.
  const registered = await registerDevice();
  if (!registered.ok) {
    console.error('');
    console.error('   ❌ ' + registered.message);
    console.error('');
    if (registered.reason === 'error') {
      console.error('   Check your ERGORA_AGENT_TOKEN and network connection.');
    }
    process.exit(1);
  }

  // Wire up file watcher events → batched sync
  onFileEvent(async (event) => {
    enqueueFileEvent(event);
    if (event.type === 'add' && NOTABLE_EXTENSIONS.has(extname(event.path).toLowerCase())) {
      console.log(`[watcher] Notable file: ${event.path}`);
    }
  });

  // Start file watcher
  startWatcher();

  // Start bridge — poll for cloud requests, run them locally
  startBridge(async (event) => {
    enqueueFileEvent(event);
  });

  console.log('✅ Ergora Local Agent running. Press Ctrl+C to stop.\n');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[main] ${signal} received — shutting down gracefully`);
    stopWatcher();
    stopBridge();
    await deregisterDevice();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
