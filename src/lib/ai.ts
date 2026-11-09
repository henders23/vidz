/**
 * The AI assistant: a streaming Claude tool-use loop whose tools are the
 * editor's own command registry. Requests go straight from this browser to the
 * Anthropic API with the user's own key; nothing passes through a vidz server.
 */
import Anthropic from '@anthropic-ai/sdk';
import { create } from 'zustand';
import { useStore } from '../store';
import { Command, commands } from './commands';
import { getSettings } from './settings';
import { snapshot } from './smart';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const MAX_STEPS = 40;
/** Models for which the API can transparently re-run a declined request on another model. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);

const SYSTEM = `You are the editing assistant built into vidz, a browser-based video editor used mostly for screen recordings, tutorials and general video editing. You edit the user's project directly by calling tools; every tool is one of the editor's own commands.

How the project works:
- Times are in seconds on the timeline. Positions (x, y) are offsets from the canvas centre in canvas pixels: positive x is right, positive y is down. The canvas size is in the project state.
- Tracks are listed top layer first. Video tracks hold footage, images, text, shapes and adjustment clips; audio tracks hold audio. Clips on one track never overlap.
- "zoom" and "effect" (blur, pixelate, spotlight) clips are adjustment layers: they change everything on the tracks beneath them for their duration. A zoom's x/y is the centre of the area to magnify.
- A clip's transition describes how it enters, blending from the clip that ends where it starts on the same track.
- Each user message begins with the current editor state. Clip and track ids change as you edit (splits create new clips), so call project_get again after edits before reusing ids.

How to work:
- Do what was asked with the fewest sensible edits, then say briefly what you changed. Everything you do in one turn is a single undo step for the user, so act rather than asking for permission; ask only when the request is genuinely ambiguous.
- To act on what is said (cut a section, find a moment, remove filler words or retakes), read the transcript with timeline_getTranscript. To act on what is visible (zoom into a button, blur an email address, point at something), look with view_frame first and work out coordinates from the image, scaled to the canvas size.
- To make something follow a moving target or animate (a blur tracking a face, a spotlight following the cursor, a title sliding in, a zoom panning), first try clip_track: put the clip over the target at the start time and it follows it automatically. If that loses the target, or for motion that is designed rather than followed, look at several frames with view_frame and set keyframes yourself with clip_setKeyframes. A clip with keyframes ignores its plain x/y/scale, so change its motion through keyframes.
- timeline_cutRanges and timeline_removeSilences shift everything after the cut. When removing several ranges, pass them all in one timeline_cutRanges call using times from before the cut.
- Captions come from timeline_addCaptions; restyle them all with captions_style rather than editing clips one by one. If you cut the timeline after captions exist, regenerate them.
- You cannot import files, record, or export; tell the user which button to use for those.

Write replies as plain conversational text without markdown formatting. Keep them short.`;

/** JSON-schema subset used by the command registry. */
interface Schema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

/** Returns a description of the first problem, or null if `value` fits `schema`. */
export function validate(schema: Schema, value: unknown, path = 'input'): string | null {
  if (schema.enum) return schema.enum.includes(value) ? null : `${path} must be one of ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a number`;
    case 'string':
      return typeof value === 'string' ? null : `${path} must be a string`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const problem = schema.items ? validate(schema.items, value[i], `${path}[${i}]`) : null;
        if (problem) return problem;
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (record[key] === undefined) return `${path}.${key} is required`;
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const problem = record[key] === undefined ? null : validate(sub, record[key], `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    default:
      return null;
  }
}

const toolName = (id: string) => id.replace(/\./g, '_');
const EXTRA_TOOLS = ['edit.undo'];
const toolCommands: Command[] = commands.filter((c) => c.params || EXTRA_TOOLS.includes(c.id));
const byToolName = new Map(toolCommands.map((c) => [toolName(c.id), c]));

/** Tool definitions are derived once from the command registry, so the request prefix stays cacheable. */
export const tools: Anthropic.Beta.BetaTool[] = toolCommands.map((c) => ({
  name: toolName(c.id),
  description: c.description,
  input_schema: c.params ?? { type: 'object', properties: {} },
  eager_input_streaming: true,
}));

async function runTool(block: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> {
  const result = (content: ToolResult['content'], is_error = false): ToolResult => ({ type: 'tool_result', tool_use_id: block.id, content, is_error });
  const command = byToolName.get(block.name);
  if (!command) return result(`Unknown tool: ${block.name}`, true);
  // With eager input streaming the API no longer validates tool input, so check it here before running anything.
  const problem = validate((command.params ?? { type: 'object' }) as Schema, block.input);
  if (problem) return result(JSON.stringify({ INVALID_INPUT: problem, received: block.input }), true);
  try {
    const value = await command.run(block.input as Record<string, unknown>);
    const image = (value as { image?: unknown } | undefined)?.image;
    if (typeof image === 'string') {
      const { width, height } = useStore.getState().project;
      return result([
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
        { type: 'text', text: `Frame shown scaled down; the canvas is ${width}x${height} pixels.` },
      ]);
    }
    return result(value === undefined ? 'Done.' : JSON.stringify(value));
  } catch (err) {
    return result(err instanceof Error ? err.message : String(err), true);
  }
}

export interface ChatItem {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  status?: 'running' | 'done' | 'failed';
}

interface AssistantState {
  items: ChatItem[];
  busy: boolean;
  send: (text: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

let history: MessageParam[] = [];
let controller: AbortController | null = null;
let nextItem = 1;

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the selected model. Pick another model in Settings.';
  if (err instanceof Anthropic.NotFoundError) return 'The selected model is not available to this API key. Pick another model in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate-limiting this key right now. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The request was not accepted: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your internet connection and try again.';
  if (err instanceof Anthropic.APIError) return `Anthropic returned an error (${err.status ?? 'unknown'}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export const useAssistant = create<AssistantState>((set, get) => {
  const add = (item: Omit<ChatItem, 'id'>) => {
    const id = nextItem++;
    set((s) => ({ items: [...s.items, { ...item, id }] }));
    return id;
  };
  const patch = (id: number, change: Partial<ChatItem> | ((item: ChatItem) => Partial<ChatItem>)) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...(typeof change === 'function' ? change(i) : change) } : i)) }));

  return {
    items: [],
    busy: false,

    stop: () => controller?.abort(),
    reset: () => {
      controller?.abort();
      history = [];
      set({ items: [] });
    },

    send: async (text) => {
      text = text.trim();
      if (!text || get().busy) return;
      const { apiKey, model } = getSettings();
      add({ kind: 'user', text });
      if (!apiKey) {
        add({ kind: 'error', text: 'Add your Anthropic API key in Settings to use the assistant.' });
        return;
      }

      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      controller = new AbortController();
      set({ busy: true });
      useStore.getState().setPlaying(false);

      // Work on a copy so an interrupted turn never leaves a dangling tool call in the conversation.
      const messages: MessageParam[] = [
        ...history,
        { role: 'user', content: `<editor_state>\n${JSON.stringify(snapshot())}\n</editor_state>\n\n${text}` },
      ];
      const undoDepth = useStore.getState().past.length;
      let badJson = 0;

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const stream = client.beta.messages.stream(
            {
              model,
              max_tokens: 32000,
              system: SYSTEM,
              tools,
              messages,
              cache_control: { type: 'ephemeral' },
              output_config: { effort: 'medium' },
              // If a safety classifier declines the request, let the API retry it on a suitable fallback model.
              ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
            },
            { signal: controller.signal },
          );
          let bubble: number | null = null;
          stream.on('text', (delta) => {
            bubble ??= add({ kind: 'assistant', text: '' });
            patch(bubble, (item) => ({ text: item.text + delta }));
          });

          let message: Anthropic.Beta.BetaMessage;
          try {
            message = await stream.finalMessage();
            badJson = 0;
          } catch (err) {
            // A tool input that was not parseable JSON: re-issue the turn a couple of times. API errors are not retried here.
            if (err instanceof Anthropic.APIError || controller.signal.aborted || badJson++ >= 2) throw err;
            continue;
          }

          if (message.stop_reason === 'refusal') {
            add({ kind: 'error', text: 'Claude declined this request.' });
            return;
          }
          messages.push({ role: 'assistant', content: message.content });
          if (message.stop_reason === 'pause_turn') continue;

          const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
          if (message.stop_reason === 'max_tokens') {
            // A cut-off tool call may hold truncated input, so never run it.
            add({ kind: 'error', text: 'The reply was cut off before it finished. Try asking for a smaller change.' });
            if (calls.length) return;
            break;
          }
          if (!calls.length) break;

          const results: ToolResult[] = [];
          for (const call of calls) {
            const item = add({ kind: 'tool', text: byToolName.get(call.name)?.title ?? call.name, status: 'running' });
            const result = controller.signal.aborted
              ? ({ type: 'tool_result', tool_use_id: call.id, content: 'Cancelled by the user.', is_error: true } satisfies ToolResult)
              : await runTool(call);
            patch(item, { status: result.is_error ? 'failed' : 'done' });
            results.push(result);
          }
          if (controller.signal.aborted) throw new Anthropic.APIUserAbortError();
          messages.push({ role: 'user', content: results });
        }
        history = messages;
      } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError || controller.signal.aborted) add({ kind: 'error', text: 'Stopped.' });
        else add({ kind: 'error', text: describeError(err) });
      } finally {
        // Collapse everything this turn changed into one undo step.
        const { past } = useStore.getState();
        if (past.length > undoDepth + 1) useStore.setState({ past: past.slice(0, undoDepth + 1) });
        controller = null;
        set((s) => ({ busy: false, items: s.items.map((i) => (i.status === 'running' ? { ...i, status: 'failed' } : i)) }));
      }
    },
  };
});
