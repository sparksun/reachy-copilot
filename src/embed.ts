/**
 * embed.ts — Main app logic
 *
 * Runs inside the Reachy Mini host shell iframe.
 * Receives a live ReachyMini handle via connectToHost(), then:
 *
 * 1. Mounts the chat UI
 * 2. Manages conversation history sent to Hermes
 * 3. Handles text + voice (STT) input
 * 4. Streams Hermes responses to the UI
 * 5. Executes robot actions extracted from the response stream
 * 6. Cleans up safely on leave
 *
 * Environment variables (injected by Vite):
 *   VITE_HERMES_URL  — Hermes API base URL (e.g. https://hermes-api.aiforce.dev)
 *   VITE_HERMES_KEY  — Hermes API_SERVER_KEY
 *
 * In production these should be set as HF Space secrets.
 */

import { connectToHost } from '@pollen-robotics/reachy-mini-sdk/host/embed';

import { streamChat, SYSTEM_PROMPT, type ChatMessage, type HermesConfig } from './hermes';
import {
  ActionStreamProcessor,
  executeAction,
  ACTION_LABELS,
} from './actions';
import {
  mountChatUI,
  addUserMessage,
  startAssistantMessage,
  setStatus,
  setInputEnabled,
  setMicRecording,
  setInputText,
  showActionChip,
} from './ui/chat';

// ---------------------------------------------------------------------------
// Config — read from Vite env vars
// ---------------------------------------------------------------------------
const HERMES_CONFIG: HermesConfig = {
  // Dev: use Vite proxy to bypass CORS (see vite.config.ts server.proxy)
  // Prod: use the real HERMES_URL set via HF Space secrets
  baseUrl: import.meta.env.DEV
    ? '/hermes-api'
    : ((import.meta.env.HERMES_URL as string | undefined) ?? ''),
  apiKey: (import.meta.env.HERMES_KEY as string | undefined) ?? '',
};

// ---------------------------------------------------------------------------
// Conversation history (stateless API — we maintain history client-side)
// ---------------------------------------------------------------------------
const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

// ---------------------------------------------------------------------------
// STT via Web Speech API
// ---------------------------------------------------------------------------
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: Event) => void) | null;
}

declare const webkitSpeechRecognition: new () => SpeechRecognition;

let recognition: SpeechRecognition | null = null;
let isRecording = false;
let isBusy = false; // true while waiting for Hermes response

function initSpeechRecognition(userLang: string): void {
  const Ctor =
    ('SpeechRecognition' in window
      ? (window as unknown as { SpeechRecognition: new () => SpeechRecognition }).SpeechRecognition
      : 'webkitSpeechRecognition' in window
        ? webkitSpeechRecognition
        : null);

  if (!Ctor) {
    console.warn('[reachy-copilot] Web Speech API not supported in this browser');
    return;
  }

  recognition = new Ctor();
  recognition.continuous = false;
  recognition.interimResults = true;
  // Use navigator.language as fallback (respects user's OS locale)
  recognition.lang = userLang || navigator.language || 'en-US';

  recognition.onresult = (e: SpeechRecognitionEvent) => {
    const transcript = Array.from(e.results)
      .map((r) => r[0].transcript)
      .join('');
    setInputText(transcript);

    // If result is final, auto-send
    if (e.results[e.resultIndex]?.isFinal) {
      stopRecording();
      const text = transcript.trim();
      if (text) handleUserMessage(text);
    }
  };

  recognition.onend = () => {
    isRecording = false;
    setMicRecording(false);
  };

  recognition.onerror = () => {
    isRecording = false;
    setMicRecording(false);
  };
}

function toggleRecording(): void {
  if (isBusy) return;
  if (!recognition) {
    alert('Speech recognition is not supported in this browser. Please type your message.');
    return;
  }
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording(): void {
  if (!recognition || isRecording) return;
  try {
    recognition.start();
    isRecording = true;
    setMicRecording(true);
    setInputText('');
  } catch (err) {
    console.warn('[reachy-copilot] could not start recognition', err);
  }
}

function stopRecording(): void {
  if (!recognition || !isRecording) return;
  recognition.stop();
  isRecording = false;
  setMicRecording(false);
}

// ---------------------------------------------------------------------------
// Hermes interaction + robot action execution
// ---------------------------------------------------------------------------
async function handleUserMessage(text: string): Promise<void> {
  if (isBusy || !text.trim()) return;
  isBusy = true;
  setInputEnabled(false);
  setStatus('thinking', 'Thinking…');

  // Add to conversation history and render in UI
  history.push({ role: 'user', content: text });
  addUserMessage(text);

  const writer = startAssistantMessage();
  const processor = new ActionStreamProcessor();

  // Track executed actions to avoid repeating the same action within a response
  const executedActions = new Set<string>();
  let fullText = '';

  // reachy handle is captured in outer scope (see main())
  const reachy = _reachyHandle;

  try {
    if (!HERMES_CONFIG.baseUrl) {
      throw new Error('VITE_HERMES_URL is not configured. Check your .env.local or HF Spaces secrets.');
    }

    for await (const chunk of streamChat(history, HERMES_CONFIG)) {
      const { visible, actions } = processor.process(chunk);
      fullText += visible;
      if (visible) writer.appendText(fullText);

      // Execute each new action once per response
      for (const action of actions) {
        if (!executedActions.has(action.type) && reachy) {
          executedActions.add(action.type);
          showActionChip(ACTION_LABELS[action.type] ?? `🤖 ${action.type}`);
          // Fire-and-forget — don't await so streaming continues
          void executeAction(reachy, action);
        }
      }
    }

    // Flush any remaining buffered content (e.g. partial action tag that never closed)
    const { visible: trailing } = processor.flush();
    if (trailing) {
      fullText += trailing;
    }

    writer.finalize();
    history.push({ role: 'assistant', content: fullText });
    setStatus('connected');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[reachy-copilot] Hermes error', err);
    writer.appendError(message);
    // Remove failed turn from history
    history.pop();
    setStatus('connected', 'Robot connected');
  } finally {
    isBusy = false;
    setInputEnabled(true);
  }
}

// ---------------------------------------------------------------------------
// Reachy handle — captured from connectToHost()
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _reachyHandle: any = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const handle = await connectToHost();
  const { reachy, theme } = handle;

  _reachyHandle = reachy;

  // Apply theme to html element so CSS tokens pick it up
  document.documentElement.setAttribute('data-theme', theme);
  handle.onThemeChange((t) => {
    document.documentElement.setAttribute('data-theme', t);
  });

  // Mount UI
  mountChatUI({
    onSend: (text) => void handleUserMessage(text),
    onMicToggle: toggleRecording,
  });

  // Init STT — use robot owner's locale if we can detect it from browser
  initSpeechRecognition(navigator.language);

  setStatus('connected');

  // Clean up when user leaves session
  handle.onLeave(async () => {
    stopRecording();
    // Return robot to neutral/home pose safely
    try {
      reachy.setHeadRpyDeg(0, 0, 0);
      reachy.setTarget({ antennas: [0, 0] });
    } catch {
      // Non-fatal
    }
    setStatus('offline', 'Session ended');
    setInputEnabled(false);
  });
}

void main().catch((err) => {
  console.error('[reachy-copilot] boot failed', err);
  window.parent.postMessage(
    {
      source: 'reachy-mini',
      type: 'embed:error',
      version: 1,
      message: String(err),
      fatal: true,
    },
    window.location.origin,
  );
});
