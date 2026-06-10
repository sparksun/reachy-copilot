/**
 * embed.ts — Main app logic
 *
 * Runs inside the Reachy Mini host shell iframe.
 * Receives a live ReachyMini handle via connectToHost(), then:
 *
 * 1. Mounts the chat UI
 * 2. Manages conversation history sent to Hermes
 * 3. Handles text + voice (STT/TTS) input/output
 * 4. Streams Hermes responses to the UI
 * 5. Executes robot actions extracted from the response stream
 * 6. Cleans up safely on leave
 *
 * Input/Output modes:
 *   - Text input  → Text output only (no TTS)
 *   - Voice input → Voice output (TTS) + text bubble shown in UI
 *
 * Noisy environment protection:
 *   - Push-to-Talk (PTT): mic button must be held to record.
 *     Releasing fires STT and sends the message automatically.
 *   - Max recording cap: 15 s (enforced in VoiceController).
 *
 * Environment variables (injected by Vite):
 *   HERMES_URL  — Hermes API base URL
 *   HERMES_KEY  — Hermes API_SERVER_KEY
 */

import { connectToHost } from '@pollen-robotics/reachy-mini-sdk/host/embed';

import { streamChat, SYSTEM_PROMPT, type ChatMessage, type HermesConfig } from './hermes';
import {
  ActionStreamProcessor,
  executeAction,
  stripActionTags,
  ACTION_LABELS,
} from './actions';
import { VoiceController } from './voice';
import {
  mountChatUI,
  addUserMessage,
  startAssistantMessage,
  setStatus,
  setInputEnabled,
  setMicMode,
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
// Input mode — determines whether to trigger TTS on reply
// ---------------------------------------------------------------------------
type InputMode = 'text' | 'voice';
let inputMode: InputMode = 'text';

// ---------------------------------------------------------------------------
// Voice controller
// ---------------------------------------------------------------------------
const voiceCtrl = new VoiceController();

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
      throw new Error('HERMES_URL is not configured. Check your .env.local or HF Spaces secrets.');
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

    // ── TTS: only play audio when the user used voice input ──────────────────
    if (inputMode === 'voice' && voiceCtrl.ttsSupported) {
      // Strip [ACTION:xxx] tags — they are invisible instructions, not speech
      const spokenText = stripActionTags(fullText).trim();
      if (spokenText) {
        setMicMode('speaking');
        voiceCtrl.speak(spokenText, () => {
          // Speech finished or was interrupted — reset mic to idle
          setMicMode('idle');
        });
      }
    }
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
// PTT handlers
// ---------------------------------------------------------------------------
function handleMicDown(): void {
  console.debug('[embed] handleMicDown — isBusy:', isBusy, 'sttSupported:', voiceCtrl.sttSupported);
  if (isBusy) return;

  if (!voiceCtrl.sttSupported) {
    alert('Speech recognition is not supported in this browser. Please type your message.');
    return;
  }

  // If TTS is playing, interrupt it first
  voiceCtrl.cancelSpeech();
  setMicMode('idle');

  inputMode = 'voice';
  setInputText('');
  // startListening is async (requests mic permission first); fire-and-forget.
  // setMicMode('listening') is called after permission is granted inside startListening.
  void voiceCtrl.startListening().then(() => {
    if (voiceCtrl.isListening) setMicMode('listening');
  });
}

function handleMicUp(): void {
  console.debug('[embed] handleMicUp — isListening:', voiceCtrl.isListening);
  if (!voiceCtrl.isListening) return;
  voiceCtrl.stopListening();
  setMicMode('idle');
  // onTranscriptFinal callback below will fire handleUserMessage
}

// ---------------------------------------------------------------------------
// Reachy handle — captured from connectToHost()
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _reachyHandle: any = null;
let isBusy = false;

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

  // Wire voice callbacks
  voiceCtrl.onTranscriptInterim = (text) => {
    console.debug('[embed] onTranscriptInterim:', JSON.stringify(text));
    setInputText(text);
  };

  voiceCtrl.onTranscriptFinal = (text) => {
    console.debug('[embed] onTranscriptFinal — sending:', JSON.stringify(text));
    setInputText('');
    void handleUserMessage(text);
  };

  // Mount UI with PTT callbacks
  mountChatUI({
    onSend: (text) => {
      inputMode = 'text';    // keyboard → text output only
      void handleUserMessage(text);
    },
    onMicDown: handleMicDown,
    onMicUp: handleMicUp,
  });

  setStatus('connected');

  // Clean up when user leaves session
  handle.onLeave(async () => {
    voiceCtrl.cancelSpeech();
    setMicMode('idle');
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
