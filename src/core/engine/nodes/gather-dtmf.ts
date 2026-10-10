import { playPrompt, retryOrExit, saveAs } from '../gather';
import type { NodeHandler, NodeRuntime, Step } from '../runtime';
import type { TypedNode } from '../schema';

type Node = TypedNode<'gather_dtmf'>;

const wait = (node: Node, rt: NodeRuntime): Step => {
  const c = node.config;
  rt.push({
    type: 'listen_dtmf',
    nodeId: node.id,
    timeoutSec: c.timeoutSec,
    maxDigits: c.mode === 'menu' ? 1 : c.maxDigits,
    finishKey: c.mode === 'menu' ? 'none' : c.finishKey,
  });
  return {
    wait: {
      kind: 'dtmf',
      nodeId: node.id,
      timeoutSec: c.timeoutSec,
      mode: c.mode,
      ...(c.mode === 'menu'
        ? { keys: c.keys.map((k) => ({ key: k.key, label: k.label })) }
        : { maxDigits: c.maxDigits, finishKey: c.finishKey }),
    },
  };
};

const language = (rt: NodeRuntime) => rt.settings.language;

/** Keypad menu (`key_<id>`) or digits collection (`next`), with retries. */
export const gatherDtmfNode: NodeHandler<'gather_dtmf'> = {
  enter: async (node, rt) => {
    rt.state.retries = 0;
    if (!(await playPrompt(node.id, node.config.prompt, language(rt), rt))) {
      return rt.fail(node.id, 'prompt audio missing');
    }
    return wait(node, rt);
  },
  input: async (node, input, rt) => {
    const c = node.config;
    const retry = (apology: string, exhausted: string) =>
      retryOrExit(node.id, c, apology, exhausted, language(rt), () => wait(node, rt), rt);
    if (input.kind === 'no_input') return retry(c.noInputText, 'no_input');
    if (input.kind !== 'dtmf') return retry(c.invalidText, 'invalid');
    const digits = input.digits;
    if (c.mode === 'menu') {
      const pressed = digits.charAt(0);
      if (c.repeatKey && pressed === c.repeatKey) {
        if (!(await playPrompt(node.id, c.prompt, language(rt), rt))) {
          return rt.fail(node.id, 'prompt audio missing');
        }
        return wait(node, rt);
      }
      const key = c.keys.find((k) => k.key === pressed);
      if (!key) return retry(c.invalidText, 'invalid');
      rt.setVar('last_dtmf', pressed);
      saveAs(c.saveAs, pressed, rt, node.id);
      return { exit: `key_${key.id}` };
    }
    const value = c.finishKey === '#' && digits.endsWith('#') ? digits.slice(0, -1) : digits;
    if (!/^[0-9*]*$/.test(value) || value.length < c.minDigits || value.length > c.maxDigits) {
      return retry(c.invalidText, 'invalid');
    }
    rt.setVar('last_dtmf', value);
    saveAs(c.saveAs, value, rt, node.id);
    return { exit: 'next' };
  },
};
