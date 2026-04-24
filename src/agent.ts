import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { LOCAL_TOOLS, executeTool } from './tools.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

export interface AgentRequest {
  id: string;
  type: 'query' | 'task';
  prompt: string;
  context?: string;
}

export interface AgentResult {
  requestId: string;
  answer: string;
  toolsUsed: string[];
  error?: string;
}

export async function runAgentRequest(req: AgentRequest): Promise<AgentResult> {
  const toolsUsed: string[] = [];
  const messages: Anthropic.MessageParam[] = [];

  const systemPrompt = `You are the Ergora Desktop Agent — a local AI assistant running on the user's machine.
You have access to the user's local files within mounted folders.
You can search for files, list folders, and read file contents.
Always be concise. When you find files, provide their full paths.
Current device: ${config.deviceName} (${config.platform})
Mounted paths: ${config.mountedPaths.join(', ') || 'None configured'}
${req.context ? `\nContext from Ergora workspace:\n${req.context}` : ''}`;

  messages.push({ role: 'user', content: req.prompt });

  // Agentic loop — max 5 turns to prevent runaway
  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools: LOCAL_TOOLS as unknown as Anthropic.Tool[],
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const answer = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');
      return { requestId: req.id, answer, toolsUsed };
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        toolsUsed.push(block.name);
        let result: unknown;
        try {
          result = executeTool(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          result = { error: (err as Error).message };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return { requestId: req.id, answer: 'Agent reached maximum turns without completing.', toolsUsed };
}
