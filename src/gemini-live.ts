/**
 * gemini-live.ts — Gemini Live API WebSocket client
 *
 * Manages a bidirectional WebSocket session with the Gemini Live API
 * (via Cloudflare AI Gateway proxy at /gemini-live).
 *
 * Protocol: Google's BidiGenerateContent over WebSocket
 *   - Client sends: setup, realtimeInput (audio/image), clientContent (text),
 *                   toolResponse (function results)
 *   - Server sends: setupComplete, serverContent (audio/text chunks, turnComplete),
 *                   toolCall (function invocations), toolCallCancellation
 *
 * Audio format:
 *   - Input:  PCM Int16, mono, 16kHz (sent as base64)
 *   - Output: PCM Int16, mono, 24kHz (received as base64)
 */

import {
  REALTIME_TOOL_DECLARATIONS,
  type FunctionCallInfo,
  type FunctionResponseInfo,
} from './realtime-tools';

/** System prompt for the Reachy Realtime persona */
const REALTIME_SYSTEM_PROMPT = `You are Reachy — a friendly, witty AI assistant physically embodied in a Reachy Mini robot.
You are having a real-time voice conversation. Keep responses concise and natural (1-3 sentences).
Be warm, curious, and playful. Always respond in the same language the user uses.
If the user speaks Chinese, respond in Chinese. If English, respond in English.

You can perform physical actions on your robot body using the robot_action tool.
When the user asks you to nod, shake head, tilt, look up/down, wave antennas or spin,
acknowledge naturally (e.g. "好的！" or "Sure!") and call the tool.

You can see through your camera using the capture_camera tool.
When the user asks what you see, call capture_camera first, then describe the image.`;

/** Model that supports bidiGenerateContent */
const LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-latest';

/** Voice name for TTS output */
const VOICE_NAME = 'Aoede';

export interface GeminiLiveCallbacks {
  onSetupComplete: () => void;
  onAudioChunk: (pcmBase64: string) => void;
  onTextDelta: (text: string) => void;
  onTurnComplete: () => void;
  onToolCall: (calls: FunctionCallInfo[]) => void;
  onToolCallCancellation: (ids: string[]) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onError: (err: Error) => void;
  onDisconnect: () => void;
}

export type GeminiLiveState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private _state: GeminiLiveState = 'disconnected';
  private callbacks: GeminiLiveCallbacks;

  constructor(callbacks: GeminiLiveCallbacks) {
    this.callbacks = callbacks;
  }

  get state(): GeminiLiveState {
    return this._state;
  }

  /**
   * Connect to the Gemini Live API via the Vite WebSocket proxy.
   * In dev: ws://localhost:5173/gemini-live
   */
  connect(): void {
    if (this.ws) {
      this.disconnect();
    }

    this._state = 'connecting';

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/gemini-live`;

    console.debug('[gemini-live] Connecting to', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.debug('[gemini-live] WebSocket connected, sending setup...');
      this.sendSetup();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = (event) => {
      console.error('[gemini-live] WebSocket error', event);
      this._state = 'error';
      this.callbacks.onError(new Error('WebSocket connection error'));
    };

    this.ws.onclose = (event) => {
      console.debug(`[gemini-live] WebSocket closed (${event.code}) ${event.reason}`);
      this._state = 'disconnected';
      this.ws = null;
      this.callbacks.onDisconnect();
    };
  }

  /** Gracefully disconnect */
  disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, 'user disconnect');
      this.ws = null;
    }
    this._state = 'disconnected';
  }

  /**
   * Send raw PCM audio (base64 encoded, 16kHz mono Int16).
   * Called continuously by the audio pipeline while recording.
   */
  sendAudio(pcmBase64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: pcmBase64,
        }],
      },
    }));
  }

  /**
   * Send a text message (for text-based interaction in realtime mode).
   */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text }] },
        ],
        turnComplete: true,
      },
    }));
  }

  // ─── Private ───────────────────────────────────────────────────────

  /**
   * Send tool execution results back to Gemini.
   * Must be called after receiving a toolCall to continue the conversation.
   */
  sendToolResponse(responses: FunctionResponseInfo[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: responses,
      },
    }));
  }

  /**
   * Send an image frame to Gemini via realtimeInput.
   * Used for camera captures — sent alongside (but separate from) toolResponse.
   */
  sendImage(jpegBase64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'image/jpeg',
          data: jpegBase64,
        }],
      },
    }));
  }

  // ─── Private ───────────────────────────────────────────────────────

  private sendSetup(): void {
    if (!this.ws) return;

    const setup = {
      setup: {
        model: LIVE_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: VOICE_NAME },
            },
          },
        },
        tools: REALTIME_TOOL_DECLARATIONS,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: REALTIME_SYSTEM_PROMPT }],
        },
      },
    };

    this.ws.send(JSON.stringify(setup));
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('[gemini-live] Non-JSON message:', raw.slice(0, 100));
      return;
    }

    // Setup complete
    if (msg.setupComplete) {
      console.debug('[gemini-live] ✅ Setup complete');
      this._state = 'connected';
      this.callbacks.onSetupComplete();
      return;
    }

    // Server content (audio chunks, text, turn complete, transcription)
    const sc = msg.serverContent as Record<string, unknown> | undefined;
    if (sc) {
      const modelTurn = sc.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined;
      if (modelTurn?.parts) {
        for (const part of modelTurn.parts) {
          // Audio data
          const inlineData = part.inlineData as { data?: string; mimeType?: string } | undefined;
          if (inlineData?.data) {
            this.callbacks.onAudioChunk(inlineData.data);
          }
          // Text data (thinking / text modality)
          if (typeof part.text === 'string' && part.text) {
            this.callbacks.onTextDelta(part.text);
          }
        }
      }

      // Input transcription (what the user said)
      const inputTranscript = sc.inputTranscript as { text?: string } | undefined;
      if (inputTranscript?.text) {
        this.callbacks.onInputTranscript(inputTranscript.text);
      }

      // Output transcription (what the model said, as text)
      const outputTranscript = sc.outputTranscript as { text?: string } | undefined;
      if (outputTranscript?.text) {
        this.callbacks.onOutputTranscript(outputTranscript.text);
      }

      if (sc.turnComplete) {
        this.callbacks.onTurnComplete();
      }
      return;
    }

    // Tool call from model
    const tc = msg.toolCall as { functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> } | undefined;
    if (tc?.functionCalls) {
      console.debug('[gemini-live] toolCall:', tc.functionCalls.map(c => c.name));
      this.callbacks.onToolCall(tc.functionCalls);
      return;
    }

    // Tool call cancellation
    const tcc = msg.toolCallCancellation as { ids?: string[] } | undefined;
    if (tcc?.ids) {
      console.debug('[gemini-live] toolCallCancellation:', tcc.ids);
      this.callbacks.onToolCallCancellation(tcc.ids);
      return;
    }

    // Error
    if (msg.error) {
      const errMsg = JSON.stringify(msg.error);
      console.error('[gemini-live] Server error:', errMsg);
      this.callbacks.onError(new Error(`Gemini error: ${errMsg}`));
    }
  }
}
