/**
 * audio-pipeline.ts — Browser audio capture & playback for Gemini Live
 *
 * Capture: getUserMedia → AudioWorklet/ScriptProcessor → PCM Int16 16kHz → base64
 * Playback: base64 PCM Int16 24kHz → Float32 → AudioBufferSourceNode queue
 *
 * The pipeline is designed to work inside the Reachy SDK iframe
 * (which has `allow="microphone"` set by the host).
 */

/** Capture sample rate expected by Gemini Live API */
const CAPTURE_SAMPLE_RATE = 16000;

/** Playback sample rate from Gemini Live API */
const PLAYBACK_SAMPLE_RATE = 24000;

/**
 * Callback for captured audio chunks.
 * Called every ~100ms with base64-encoded PCM Int16 mono data.
 */
export type AudioCaptureCallback = (pcmBase64: string) => void;

/**
 * Audio capture pipeline.
 * Uses getUserMedia + ScriptProcessorNode to capture mic audio,
 * downsamples to 16kHz, converts to Int16, and fires callback with base64.
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _active = false;

  /**
   * Start capturing audio from the microphone.
   * @param onChunk - Called with base64 PCM chunks every ~100ms
   */
  async start(onChunk: AudioCaptureCallback): Promise<void> {
    if (this._active) return;

    // Get mic stream
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: CAPTURE_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Create AudioContext at the desired sample rate
    this.audioCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    this.source = this.audioCtx.createMediaStreamSource(this.stream);

    // Use ScriptProcessorNode for wide browser compat
    // Buffer size ~100ms at 16kHz = 1600 samples, round to power of 2 = 2048
    const bufferSize = 2048;
    this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this._active) return;

      const float32 = e.inputBuffer.getChannelData(0);
      // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Encode as base64
      const base64 = arrayBufferToBase64(int16.buffer);
      onChunk(base64);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
    this._active = true;

    console.debug('[audio-capture] Started, sampleRate:', this.audioCtx.sampleRate);
  }

  /** Stop capturing and release resources */
  stop(): void {
    this._active = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    console.debug('[audio-capture] Stopped');
  }

  get active(): boolean {
    return this._active;
  }
}

/**
 * Audio playback pipeline.
 * Receives base64-encoded PCM Int16 24kHz chunks and plays them
 * in sequence using AudioBufferSourceNode chaining.
 */
export class AudioPlayback {
  private audioCtx: AudioContext | null = null;
  /** Scheduled end time of the last queued buffer */
  private nextStartTime = 0;
  private _playing = false;

  /** Initialize the playback context (call once) */
  init(): void {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    console.debug('[audio-playback] Initialized, sampleRate:', PLAYBACK_SAMPLE_RATE);
  }

  /**
   * Queue a PCM audio chunk for playback.
   * Chunks are automatically chained for gapless playback.
   */
  playChunk(pcmBase64: string): void {
    if (!this.audioCtx) this.init();
    const ctx = this.audioCtx!;

    // Resume AudioContext if suspended (autoplay policy)
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    // Decode base64 → Int16 → Float32
    const rawBytes = base64ToArrayBuffer(pcmBase64);
    const int16 = new Int16Array(rawBytes);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    // Create AudioBuffer
    const buffer = ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    // Schedule playback
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this._playing = true;

    source.onended = () => {
      // If this was the last buffer, mark as not playing
      if (ctx.currentTime >= this.nextStartTime - 0.01) {
        this._playing = false;
      }
    };
  }

  /** Flush all queued audio and stop playback */
  flush(): void {
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.nextStartTime = 0;
    this._playing = false;
    // Re-init for next use
    this.init();
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Clean up resources */
  destroy(): void {
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this._playing = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert base64 string to ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
