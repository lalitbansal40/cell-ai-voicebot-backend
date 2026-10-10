import type { NodeRuntime, Step } from './runtime';
import type { NodeConfig } from './schema';
import type { FlowInput } from './types';
import { coerce, type ValueType } from './variables';

type Prompt = NodeConfig<'gather_dtmf'>['prompt'];

/** Says / plays a gather prompt. Missing audio → its fallback text, else `false`. */
export const playPrompt = async (
  nodeId: string,
  prompt: Prompt,
  language: string,
  rt: NodeRuntime,
): Promise<boolean> => {
  if (prompt.kind === 'speak') {
    rt.say(nodeId, rt.render(prompt.text, nodeId), { language });
    return true;
  }
  const audio = await rt.effects.loadAudio(prompt.audioId);
  if (audio) {
    rt.push({ type: 'play', nodeId, audioId: audio.id, audioName: audio.name });
    return true;
  }
  if (prompt.fallbackText) {
    rt.say(nodeId, rt.render(prompt.fallbackText, nodeId), { language });
    return true;
  }
  return false;
};

/**
 * A miss (timeout / invalid / no match): retry with the apology + prompt while
 * retries are left (per visit), else the exhausted exit.
 */
export const retryOrExit = async (
  nodeId: string,
  config: { prompt: Prompt; maxRetries: number },
  apology: string,
  exhausted: string,
  language: string,
  wait: () => Step,
  rt: NodeRuntime,
): Promise<Step> => {
  if (rt.state.retries >= config.maxRetries) return { exit: exhausted };
  rt.state.retries += 1;
  rt.say(nodeId, rt.render(apology, nodeId), { language });
  if (!(await playPrompt(nodeId, config.prompt, language, rt))) {
    return rt.fail(nodeId, 'prompt audio missing');
  }
  return wait();
};

/** Saves a gathered value into a flow variable (typed); bad values become `null`. */
export const saveAs = (name: string | null, raw: string, rt: NodeRuntime, nodeId: string) => {
  if (!name) return;
  const type = rt.varType(name);
  try {
    rt.setVar(name, coerceFor(type, raw));
  } catch {
    rt.setVar(name, null);
    rt.note(nodeId, `"${raw}" is not a valid ${type} for ${name}`);
  }
};

const coerceFor = (type: ValueType, raw: string) =>
  coerce(type === 'number' || type === 'boolean' || type === 'date' ? type : 'text', raw);

export const isKind = <K extends FlowInput['kind']>(
  input: FlowInput,
  kind: K,
): input is Extract<FlowInput, { kind: K }> => input.kind === kind;
