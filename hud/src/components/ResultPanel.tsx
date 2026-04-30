import { open } from '@tauri-apps/plugin-shell';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { ArrowUpRight, Brain, FileText, Folder, Wrench, Zap, Volume2 } from 'lucide-react';
import type { VoiceResponse } from '../lib/api';

interface Props {
  response: VoiceResponse;
  apiUrl: string;
  onDismiss: () => void;
}

export function ResultPanel({ response, apiUrl, onDismiss }: Props) {
  if (!response.ok) {
    return (
      <div className="px-4 py-3 text-sm text-rose-300">
        Couldn't dispatch: {response.error}
      </div>
    );
  }
  switch (response.action) {
    case 'find-file':
      return <FindFileResult res={response} onDismiss={onDismiss} />;
    case 'capture-to-brain':
      return <CaptureResult res={response} />;
    case 'open-tool':
      return <OpenToolResult res={response} apiUrl={apiUrl} onDismiss={onDismiss} />;
    case 'run-task':
      return <RunTaskResult res={response} />;
    case 'run-task-disambiguate':
      return <DisambiguateResult res={response} />;
    case 'chat':
      return <ChatResult res={response} />;
  }
}

function FindFileResult({
  res,
  onDismiss,
}: {
  res: Extract<VoiceResponse, { action: 'find-file' }>;
  onDismiss: () => void;
}) {
  const matches = res.matches ?? [];
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-slate-300">
        <Folder className="h-4 w-4 text-ergora-amber" />
        <span>{res.spoken}</span>
      </div>
      {matches.length > 0 ? (
        <ul className="mt-2 max-h-56 space-y-1 overflow-auto hud-scroll">
          {matches.map((m, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await revealItemInDir(m.path);
                  } catch (err) {
                    console.warn('reveal failed', err);
                  }
                  onDismiss();
                }}
                className="hud-no-drag flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] text-slate-200 hover:bg-white/5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="truncate">{m.path}</span>
                </span>
                {m.deviceName && (
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-500">
                    {m.deviceName}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          No matches yet — your devices will report back as they finish searching.
        </p>
      )}
    </div>
  );
}

function CaptureResult({ res }: { res: Extract<VoiceResponse, { action: 'capture-to-brain' }> }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-slate-200">
        <Brain className="h-4 w-4 text-ergora-amber" />
        <span>{res.spoken}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Saved under <span className="text-slate-300">{res.slice}</span>. Opens in your project wiki.
      </p>
    </div>
  );
}

function OpenToolResult({
  res,
  apiUrl,
  onDismiss,
}: {
  res: Extract<VoiceResponse, { action: 'open-tool' }>;
  apiUrl: string;
  onDismiss: () => void;
}) {
  const portalBase = apiUrl.replace(/\/$/, '').replace('https://ergora.cloud', 'https://ergora.cloud');
  const url = `${portalBase}/portal?tool=${encodeURIComponent(res.toolId)}`;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-slate-200">
        <Wrench className="h-4 w-4 text-ergora-amber" />
        <span>{res.spoken}</span>
      </div>
      <button
        type="button"
        onClick={async () => {
          await open(url).catch(() => {});
          onDismiss();
        }}
        className="hud-no-drag mt-2 inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/10"
      >
        Switch to portal
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function RunTaskResult({ res }: { res: Extract<VoiceResponse, { action: 'run-task' }> }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-slate-200">
        <Zap className="h-4 w-4 text-ergora-amber" />
        <span>{res.spoken}</span>
      </div>
      {res.taskId && (
        <p className="mt-1 text-xs text-slate-500">
          Run id <span className="text-slate-300">{res.taskId.slice(0, 8)}</span> queued.
        </p>
      )}
    </div>
  );
}

function DisambiguateResult({
  res,
}: {
  res: Extract<VoiceResponse, { action: 'run-task-disambiguate' }>;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-slate-200">
        <Zap className="h-4 w-4 text-ergora-amber" />
        <span>{res.spoken}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {res.matches.map((m) => (
          <li key={m.id} className="text-[13px] text-slate-300">{m.name}</li>
        ))}
      </ul>
    </div>
  );
}

function ChatResult({ res }: { res: Extract<VoiceResponse, { action: 'chat' }> }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-2 text-sm text-slate-200">
        <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-ergora-amber" />
        <p className="leading-relaxed">
          {res.replyText ?? 'Thinking…'}
        </p>
      </div>
    </div>
  );
}
