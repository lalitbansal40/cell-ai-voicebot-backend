import type { NodeHandler } from '../runtime';

export const IN_PHONE = /^\+91[6-9]\d{9}$/;

/** Hands the call to a person; `connected` ends the run, else `failed` / `no_answer`. */
export const transferNode: NodeHandler<'transfer_to_agent'> = {
  enter: (node, rt) => {
    const phone = rt.render(node.config.phone, node.id).trim();
    if (!IN_PHONE.test(phone))
      return Promise.resolve(rt.fail(node.id, 'transfer number is not valid'));
    if (node.config.announcement) rt.say(node.id, rt.render(node.config.announcement, node.id));
    rt.push({ type: 'transfer', nodeId: node.id, phone, timeoutSec: node.config.timeoutSec });
    return Promise.resolve({
      wait: {
        kind: 'transfer',
        nodeId: node.id,
        timeoutSec: node.config.timeoutSec,
        transferPhoneLast4: phone.slice(-4),
      },
    });
  },
  input: (node, input, rt) => {
    if (input.kind !== 'transfer_result')
      return Promise.resolve(rt.fail(node.id, 'unexpected input'));
    rt.state.outcome.transfer = { result: input.result };
    rt.setVar('transfer_result', input.result);
    return Promise.resolve(
      input.result === 'connected' ? { end: 'transferred' as const } : { exit: input.result },
    );
  },
};
