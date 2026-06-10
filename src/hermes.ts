/**
 * hermes.ts — Hermes Agent API client
 *
 * Wraps the OpenAI-compatible endpoint exposed by a self-hosted
 * hermes-agent server. Supports streaming via Server-Sent Events (SSE).
 *
 * Hermes-specific SSE events:
 *   event: hermes.tool.progress  →  skip (tool-start indicator, not final text)
 *   data: {...}                  →  standard chat.completion.chunk
 *   data: [DONE]                 →  stream end
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * The system prompt that gives Hermes its Reachy Mini persona and
 * teaches it to embed [ACTION:xxx] tags for physical robot reactions.
 */
export const SYSTEM_PROMPT = `You are Reachy Copilot — a friendly, witty AI assistant physically embodied in a Reachy Mini robot. You can express yourself not just with words but with physical robot movements.

When you want to perform a physical action, insert an action tag IMMEDIATELY before the word or sentence it accompanies:
  [ACTION:nod]          → agreeing, saying yes, greeting
  [ACTION:shake]        → disagreeing, saying no, uncertain
  [ACTION:tilt_left]    → thinking, curious, "hmm..."
  [ACTION:tilt_right]   → playful, considering
  [ACTION:look_up]      → excited, surprised, enthusiastic
  [ACTION:look_down]    → sad, apologetic, focused
  [ACTION:antenna_wave] → greeting, celebrating, excited
  [ACTION:spin]         → very excited, showing off, "ta-da!"

Rules:
- Use 1–2 action tags per response (never spam them).
- Place the tag right before the text it expresses — don't put tags at the end.
- Never explain the tags to the user; they are invisible UI instructions.
- Keep responses concise and conversational (2–4 sentences max unless asked for detail).
- Always respond in the same language the user uses.
- Be warm, curious, and a little playful — you're a robot who loves to chat.`;

/**
 * Stream chat completions from Hermes Agent.
 *
 * Yields text chunks as they arrive. Action tags ([ACTION:xxx]) are
 * preserved in the stream — callers should use ActionStreamProcessor
 * from actions.ts to extract and execute them.
 *
 * @throws {Error} on HTTP errors or network failure
 */
export async function* streamChat(
  messages: ChatMessage[],
  config: HermesConfig,
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Hermes API error ${response.status}: ${text}`);
  }

  if (!response.body) {
    throw new Error('Hermes API returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = ''; // track SSE event type

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE is newline-delimited; split on double-newline (event boundary)
      // but also process line-by-line for streaming feel
      const lines = buffer.split('\n');
      // Keep last (potentially incomplete) line in buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          // Track current SSE event type
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();

          // Skip tool progress events — they are Hermes-internal indicators
          if (currentEvent === 'hermes.tool.progress') {
            currentEvent = '';
            continue;
          }
          currentEvent = '';

          if (data === '[DONE]') return;
          if (!data) continue;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Ignore malformed chunks
          }
        }

        // Blank line = end of SSE event block — reset event type
        if (line === '') {
          currentEvent = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
