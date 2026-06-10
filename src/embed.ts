import { startThinkingAnimation } from './actions';

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
import { GeminiLiveClient } from './gemini-live';
import { AudioCapture, AudioPlayback } from './audio-pipeline';
import { handleToolCall } from './realtime-tools';
import {
  mountChatUI,
  addUserMessage,
  startAssistantMessage,
  setStatus,
  setInputEnabled,
  setMicMode,
  setInputText,
  showActionChip,
  setMode,
  setRealtimeStatus,
  appendRealtimeTranscript,
  clearRealtimeTranscript,
  type AppMode,
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

  // Start thinking animation while Hermes processes (tool calls, search…)
  const thinkingAnim = reachy ? startThinkingAnimation(reachy) : null;
  let thinkingStopped = false;

  try {
    if (!HERMES_CONFIG.baseUrl) {
      throw new Error('HERMES_URL is not configured. Check your .env.local or HF Spaces secrets.');
    }

    for await (const chunk of streamChat(history, HERMES_CONFIG)) {
      const { visible, actions } = processor.process(chunk);
      fullText += visible;
      if (visible) {
        // Stop thinking animation on first text chunk
        if (!thinkingStopped && thinkingAnim) {
          thinkingAnim.stop();
          thinkingStopped = true;
        }
        writer.appendText(visible);
      }

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
    // Always stop thinking animation (safe if already stopped)
    if (!thinkingStopped) thinkingAnim?.stop();
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
  voiceCtrl.startListening();
  setMicMode('listening');
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

/** Hidden video element for camera frame capture (bound to Reachy WebRTC stream) */
let _cameraVideo: HTMLVideoElement | null = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const handle = await connectToHost();
  const { reachy, theme } = handle;

  _reachyHandle = reachy;

  // Create a hidden <video> element for camera frame capture.
  // The Reachy camera feed comes via WebRTC; handle.media.attachVideo()
  // binds the MediaStream so we can capture frames with canvas.
  _cameraVideo = document.createElement('video');
  _cameraVideo.playsInline = true;
  _cameraVideo.muted = true;
  _cameraVideo.autoplay = true;
  _cameraVideo.style.position = 'fixed';
  _cameraVideo.style.opacity = '0';
  _cameraVideo.style.pointerEvents = 'none';
  _cameraVideo.style.width = '1px';
  _cameraVideo.style.height = '1px';
  document.body.appendChild(_cameraVideo);
  handle.media.attachVideo(_cameraVideo);
  console.debug('[embed] Camera video element created and attached');

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

  // Mount UI with PTT callbacks + mode change
  mountChatUI({
    onSend: (text) => {
      inputMode = 'text';    // keyboard → text output only
      void handleUserMessage(text);
    },
    onMicDown: handleMicDown,
    onMicUp: handleMicUp,
    onModeChange: (mode) => void handleModeChange(mode),
  });

  setStatus('connected');

  // Clean up when user leaves session
  handle.onLeave(async () => {
    voiceCtrl.cancelSpeech();
    setMicMode('idle');
    // Disconnect realtime if active
    stopRealtimeMode();
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

// ---------------------------------------------------------------------------
// Realtime mode lifecycle
// ---------------------------------------------------------------------------
let liveClient: GeminiLiveClient | null = null;
let audioCapture: AudioCapture | null = null;
let audioPlayback: AudioPlayback | null = null;

async function handleModeChange(mode: AppMode): Promise<void> {
  if (mode === 'realtime') {
    await startRealtimeMode();
  } else {
    stopRealtimeMode();
  }
}

/**
 * Capture a JPEG frame from the Reachy camera (WebRTC video stream).
 * Returns base64-encoded JPEG data or null if no video element is found.
 */
function captureFrame(): string | null {
  if (!_cameraVideo || _cameraVideo.videoWidth === 0) {
    console.warn('[embed] captureFrame: camera video not ready',
      { hasEl: !!_cameraVideo, w: _cameraVideo?.videoWidth, h: _cameraVideo?.videoHeight });
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = _cameraVideo.videoWidth;
  canvas.height = _cameraVideo.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(_cameraVideo, 0, 0);
  // toDataURL returns "data:image/jpeg;base64,..." — strip the prefix
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  const base64 = dataUrl.split(',')[1] || null;
  if (base64) {
    console.debug('[embed] captureFrame: captured', _cameraVideo.videoWidth, 'x', _cameraVideo.videoHeight);
  }
  return base64;
}

async function startRealtimeMode(): Promise<void> {
  setMode('realtime');
  setRealtimeStatus('connecting');

  audioPlayback = new AudioPlayback();
  audioPlayback.init();

  audioCapture = new AudioCapture();

  liveClient = new GeminiLiveClient({
    onSetupComplete: () => {
      console.debug('[embed] Gemini Live setup complete');
      setRealtimeStatus('connected');

      // Start capturing audio
      audioCapture!.start((pcmBase64) => {
        liveClient!.sendAudio(pcmBase64);
      }).then(() => {
        setRealtimeStatus('listening');
        // Antenna up while listening
        if (_reachyHandle) {
          _reachyHandle.setTarget({ antennas: [0.2, 0.2] });
        }
      }).catch((err) => {
        console.error('[embed] Mic capture failed:', err);
        setRealtimeStatus('error');
      });
    },

    onAudioChunk: (pcmBase64) => {
      setRealtimeStatus('ai-speaking');
      audioPlayback!.playChunk(pcmBase64);
      // Antenna wiggle while speaking
      if (_reachyHandle) {
        _reachyHandle.setTarget({ antennas: [0.35, 0.0] });
      }
    },

    onTextDelta: (text) => {
      // Model thinking text — log only, not shown in transcript
      console.debug('[embed] model text:', text.slice(0, 80));
    },

    onTurnComplete: () => {
      setRealtimeStatus('listening');
      // Reset antennas to gentle listening pose
      if (_reachyHandle) {
        _reachyHandle.setTarget({ antennas: [0.2, 0.2] });
      }
    },

    onToolCall: async (calls) => {
      console.debug('[embed] onToolCall:', calls.map(c => `${c.name}(${JSON.stringify(c.args)})`));
      // Show thinking animation during tool execution
      setRealtimeStatus('ai-thinking');
      if (_reachyHandle) {
        _reachyHandle.setTarget({ antennas: [0.0, 0.35] });
      }

      const responses = [];
      for (const call of calls) {
        const result = await handleToolCall(
          call,
          _reachyHandle,
          (jpegBase64) => liveClient!.sendImage(jpegBase64),
          captureFrame,
        );
        responses.push(result);
      }

      // Send all responses back to Gemini
      liveClient!.sendToolResponse(responses);
      setRealtimeStatus('listening');
    },

    onToolCallCancellation: (ids) => {
      console.debug('[embed] Tool calls cancelled:', ids);
    },

    onInputTranscript: (text) => {
      appendRealtimeTranscript(text, 'user');
    },

    onOutputTranscript: (text) => {
      appendRealtimeTranscript(text, 'assistant');
    },

    onError: (err) => {
      console.error('[embed] Gemini Live error:', err);
      setRealtimeStatus('error');
    },

    onDisconnect: () => {
      console.debug('[embed] Gemini Live disconnected');
      setRealtimeStatus('disconnected');
      // Reset antennas
      if (_reachyHandle) {
        _reachyHandle.setTarget({ antennas: [0, 0] });
      }
    },
  });

  liveClient.connect();
}

function stopRealtimeMode(): void {
  setMode('text');

  if (audioCapture) {
    audioCapture.stop();
    audioCapture = null;
  }
  if (audioPlayback) {
    audioPlayback.destroy();
    audioPlayback = null;
  }
  if (liveClient) {
    liveClient.disconnect();
    liveClient = null;
  }

  clearRealtimeTranscript();

  // Reset antennas
  if (_reachyHandle) {
    _reachyHandle.setTarget({ antennas: [0, 0] });
  }
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
