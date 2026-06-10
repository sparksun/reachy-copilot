/**
 * realtime-tools.ts — Function declarations & execution for Gemini Live Realtime mode
 *
 * Declares the tools sent in the BidiGenerateContent setup message:
 *   - robot_action: perform physical actions on the Reachy Mini robot
 *   - capture_camera: capture a photo from the robot's camera
 *
 * Also provides handleToolCall() to execute a tool call from Gemini
 * and return the appropriate toolResponse payload.
 */

import { executeAction, type ActionType } from './actions';

// ─── Type definitions ────────────────────────────────────────────────────────

/** Shape of a single function call received from Gemini Live */
export interface FunctionCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Shape of a function response sent back to Gemini Live */
export interface FunctionResponseInfo {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

/** Callback to capture a camera frame; returns JPEG base64 or null */
export type CaptureFrameFn = () => string | null;

// ─── Tool declarations (sent in setup message) ──────────────────────────────

/**
 * Tool declarations for Gemini Live API setup.
 * These tell the model what tools are available during the session.
 */
export const REALTIME_TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'robot_action',
        description:
          'Perform a physical action on the Reachy Mini robot body. ' +
          'Use this when the user asks the robot to nod, shake head, tilt head, ' +
          'look up, look down, wave antennas, or spin around.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: {
              type: 'STRING',
              enum: [
                'nod', 'shake', 'tilt_left', 'tilt_right',
                'look_up', 'look_down', 'antenna_wave', 'spin',
              ],
              description: 'The physical action to perform on the robot',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'capture_camera',
        description:
          'Capture a photo from the robot camera to see what is in front of the robot. ' +
          'Use this when the user asks what the robot can see, or asks about surroundings.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
    ],
  },
];

// ─── Valid action types for runtime validation ───────────────────────────────

const VALID_ACTIONS = new Set<string>([
  'nod', 'shake', 'tilt_left', 'tilt_right',
  'look_up', 'look_down', 'antenna_wave', 'spin',
]);

// ─── Tool call executor ─────────────────────────────────────────────────────

/**
 * Execute a tool call from Gemini Live and return the function response.
 *
 * For `robot_action`: executes the action on the robot via executeAction().
 * For `capture_camera`: captures a frame, sends it via sendImageFn,
 *   and returns a status indicating the image was sent.
 *
 * @param call - The function call info from Gemini
 * @param reachy - The live Reachy SDK handle
 * @param sendImageFn - Callback to send a JPEG frame to Gemini via realtimeInput
 * @param captureFrameFn - Callback to capture a JPEG frame from the robot camera
 */
export async function handleToolCall(
  call: FunctionCallInfo,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reachy: any,
  sendImageFn: (jpegBase64: string) => void,
  captureFrameFn: CaptureFrameFn,
): Promise<FunctionResponseInfo> {
  switch (call.name) {
    case 'robot_action': {
      const actionName = String(call.args?.action ?? '');
      if (!VALID_ACTIONS.has(actionName)) {
        return {
          id: call.id,
          name: call.name,
          response: { error: `Unknown action: ${actionName}` },
        };
      }

      console.debug('[realtime-tools] Executing robot action:', actionName);
      await executeAction(reachy, { type: actionName as ActionType });

      return {
        id: call.id,
        name: call.name,
        response: { result: `Action '${actionName}' executed successfully.` },
      };
    }

    case 'capture_camera': {
      console.debug('[realtime-tools] Capturing camera frame...');
      const frame = captureFrameFn();

      if (!frame) {
        return {
          id: call.id,
          name: call.name,
          response: { error: 'Camera frame capture failed. No video source available.' },
        };
      }

      // Send image as realtimeInput (separate from toolResponse)
      sendImageFn(frame);

      return {
        id: call.id,
        name: call.name,
        response: { status: 'Camera frame captured and sent. Describe what you see in the image.' },
      };
    }

    default:
      return {
        id: call.id,
        name: call.name,
        response: { error: `Unknown tool: ${call.name}` },
      };
  }
}
