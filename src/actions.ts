/**
 * actions.ts — Robot action tag parser and executor
 *
 * Parses [ACTION:xxx] tags embedded by Hermes in its text responses
 * and maps them to Reachy Mini SDK calls.
 *
 * SDK quick reference (from javascript-sdk.md):
 *   reachy.setHeadRpyDeg(roll, pitch, yaw) → boolean
 *   reachy.setTarget({ head?, antennas?, body_yaw? }) → boolean
 *     - antennas: [rightRad, leftRad]
 *     - body_yaw: radians
 *
 * All motion sequences use setHeadRpyDeg for smooth interpolation.
 * We sleep between steps with requestAnimationFrame timing to avoid
 * flooding the WebRTC data channel.
 */

/** Raw action type names matching the system prompt tags */
export type ActionType =
  | 'nod'
  | 'shake'
  | 'tilt_left'
  | 'tilt_right'
  | 'look_up'
  | 'look_down'
  | 'antenna_wave'
  | 'spin';

export interface Action {
  type: ActionType;
}

/** Regex to detect a complete [ACTION:xxx] tag */
const ACTION_TAG_RE = /\[ACTION:(\w+)\]/g;

/** Regex to strip all action tags from display text */
const STRIP_TAGS_RE = /\[ACTION:\w+\]/g;

/**
 * Strip all [ACTION:xxx] tags from text for clean display.
 */
export function stripActionTags(text: string): string {
  return text.replace(STRIP_TAGS_RE, '');
}

/**
 * Parse all complete [ACTION:xxx] tags from a text string.
 * Returns only recognised action types; unknown tags are silently ignored.
 */
export function parseActions(text: string): Action[] {
  const actions: Action[] = [];
  const validTypes = new Set<string>([
    'nod', 'shake', 'tilt_left', 'tilt_right',
    'look_up', 'look_down', 'antenna_wave', 'spin',
  ]);

  let match: RegExpExecArray | null;
  ACTION_TAG_RE.lastIndex = 0;
  while ((match = ACTION_TAG_RE.exec(text)) !== null) {
    const tag = match[1];
    if (validTypes.has(tag)) {
      actions.push({ type: tag as ActionType });
    }
  }
  return actions;
}

/**
 * Incremental stream processor: call process(chunk) for each SSE chunk.
 * Returns visible text to append to the UI and any newly-completed actions
 * to execute on the robot.
 *
 * Handles the case where [ACTION:xxx] tags are split across SSE chunks.
 */
export class ActionStreamProcessor {
  private buffer = '';

  /**
   * Feed the next chunk from the SSE stream.
   * @returns { visible: string, actions: Action[] }
   */
  process(chunk: string): { visible: string; actions: Action[] } {
    this.buffer += chunk;
    const actions: Action[] = [];
    let visible = '';

    while (this.buffer.length > 0) {
      const tagStart = this.buffer.indexOf('[ACTION:');

      if (tagStart === -1) {
        // No action tag found — check if tail might be start of one
        const partialStart = this._findPartialTagStart(this.buffer);
        if (partialStart >= 0) {
          visible += this.buffer.slice(0, partialStart);
          this.buffer = this.buffer.slice(partialStart);
        } else {
          visible += this.buffer;
          this.buffer = '';
        }
        break;
      }

      // Text before the tag is safe to display
      visible += this.buffer.slice(0, tagStart);
      const remaining = this.buffer.slice(tagStart);
      const tagEnd = remaining.indexOf(']');

      if (tagEnd === -1) {
        // Incomplete tag — buffer it and wait for more chunks
        this.buffer = remaining;
        break;
      }

      // Complete tag: extract type, record action, skip tag in visible text
      const tagContent = remaining.slice(8, tagEnd); // skip '[ACTION:'
      const validTypes = new Set(['nod','shake','tilt_left','tilt_right','look_up','look_down','antenna_wave','spin']);
      if (validTypes.has(tagContent)) {
        actions.push({ type: tagContent as ActionType });
      }

      this.buffer = remaining.slice(tagEnd + 1);
    }

    return { visible, actions };
  }

  /** Flush any remaining buffer at stream end */
  flush(): { visible: string; actions: Action[] } {
    const result = { visible: stripActionTags(this.buffer), actions: [] as Action[] };
    this.buffer = '';
    return result;
  }

  /** Check if text ends with partial start of '[ACTION:' */
  private _findPartialTagStart(text: string): number {
    const prefix = '[ACTION:';
    for (let len = Math.min(prefix.length - 1, text.length); len > 0; len--) {
      if (text.endsWith(prefix.slice(0, len))) {
        return text.length - len;
      }
    }
    return -1;
  }
}

/** Simple sleep using setTimeout */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute a single robot action via the Reachy Mini SDK.
 *
 * Uses setHeadRpyDeg(roll_deg, pitch_deg, yaw_deg) and setTarget for
 * antennas / body. Motion is fire-and-forget; we sleep between steps
 * to give the robot time to interpolate.
 *
 * @param reachy - The live ReachyMiniInstance from connectToHost()
 * @param action - Action to execute
 */
export async function executeAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reachy: any,
  action: Action,
): Promise<void> {
  try {
    switch (action.type) {
      case 'nod':
        // Head tilts forward then returns
        reachy.setHeadRpyDeg(0, -15, 0);
        await sleep(400);
        reachy.setHeadRpyDeg(0, 0, 0);
        break;

      case 'shake':
        // Head turns left, right, center
        reachy.setHeadRpyDeg(0, 0, -20);
        await sleep(300);
        reachy.setHeadRpyDeg(0, 0, 20);
        await sleep(300);
        reachy.setHeadRpyDeg(0, 0, 0);
        break;

      case 'tilt_left':
        // Head rolls left (curious)
        reachy.setHeadRpyDeg(-20, 0, 0);
        await sleep(600);
        reachy.setHeadRpyDeg(0, 0, 0);
        break;

      case 'tilt_right':
        // Head rolls right (playful)
        reachy.setHeadRpyDeg(20, 0, 0);
        await sleep(600);
        reachy.setHeadRpyDeg(0, 0, 0);
        break;

      case 'look_up':
        // Head pitches up (excited/surprised)
        reachy.setHeadRpyDeg(0, 20, 0);
        await sleep(500);
        reachy.setHeadRpyDeg(0, 0, 0);
        break;

      case 'look_down':
        // Head pitches down (sad/apologetic)
        reachy.setHeadRpyDeg(0, -10, 0);
        await sleep(700);
        reachy.setHeadRpyDeg(0, 0, 0);
        break;

      case 'antenna_wave': {
        // Antennas [rightRad, leftRad]: raise then lower
        const UP = 0.8;
        const DOWN = 0.0;
        reachy.setTarget({ antennas: [UP, UP] });
        await sleep(400);
        reachy.setTarget({ antennas: [DOWN, DOWN] });
        await sleep(300);
        reachy.setTarget({ antennas: [UP, UP] });
        await sleep(300);
        reachy.setTarget({ antennas: [DOWN, DOWN] });
        break;
      }

      case 'spin':
        // Body yaw rotation (360° in steps)
        for (let deg = 0; deg <= 360; deg += 45) {
          reachy.setTarget({ body_yaw: (deg * Math.PI) / 180 });
          await sleep(150);
        }
        reachy.setTarget({ body_yaw: 0 });
        break;

      default:
        break;
    }
  } catch (err) {
    // Non-fatal: action failed, log and continue
    console.warn('[reachy-copilot] action execution failed', action, err);
  }
}

/** Action display labels for the UI status chip */
export const ACTION_LABELS: Record<ActionType, string> = {
  nod: '👍 Nodding',
  shake: '❌ Shaking head',
  tilt_left: '🤔 Thinking',
  tilt_right: '😏 Considering',
  look_up: '✨ Excited!',
  look_down: '😔 Hmm...',
  antenna_wave: '📡 Waving!',
  spin: '🎉 Spinning!',
};

/**
 * Start a looping "thinking" idle animation on the robot.
 * Gently tilts head left/right with slow antenna wiggle.
 * Returns a stop() handle — call it when text starts arriving.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startThinkingAnimation(reachy: any): { stop: () => void } {
  let running = true;

  const loop = async () => {
    const TILT = 12;        // degrees — subtle head tilt
    const ANT_UP = 0.35;    // radians — gentle antenna raise
    const ANT_DOWN = 0.0;
    const STEP_MS = 800;    // time per pose

    while (running) {
      // Tilt left + raise left antenna
      reachy.setHeadRpyDeg(-TILT, -5, 0);
      reachy.setTarget({ antennas: [ANT_DOWN, ANT_UP] });
      await sleep(STEP_MS);
      if (!running) break;

      // Tilt right + raise right antenna
      reachy.setHeadRpyDeg(TILT, -5, 0);
      reachy.setTarget({ antennas: [ANT_UP, ANT_DOWN] });
      await sleep(STEP_MS);
      if (!running) break;
    }

    // Reset to neutral on stop
    reachy.setHeadRpyDeg(0, 0, 0);
    reachy.setTarget({ antennas: [ANT_DOWN, ANT_DOWN] });
  };

  void loop();
  return { stop: () => { running = false; } };
}
