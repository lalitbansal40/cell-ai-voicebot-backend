import type { NodeHandler } from '../runtime';
import { CoercionError, coerce } from '../variables';

/** `set` (rendered, typed), `increment` (numbers) or `clear`. Bad values → error exit. */
export const setVariableNode: NodeHandler<'set_variable'> = {
  enter: (node, rt) => {
    for (const a of node.config.assignments) {
      const type = rt.varType(a.variable);
      const flowType = type === 'number' || type === 'boolean' || type === 'date' ? type : 'text';
      try {
        if (a.op === 'clear') rt.setVar(a.variable, null);
        else if (a.op === 'increment') {
          const by = coerce('number', rt.render(a.value ?? '', node.id));
          const current = rt.getVar(a.variable);
          const base = typeof current === 'number' ? current : 0;
          if (typeof by !== 'number') throw new CoercionError('number', a.value);
          rt.setVar(a.variable, base + by);
        } else {
          rt.setVar(a.variable, coerce(flowType, rt.render(a.value ?? '', node.id)));
        }
      } catch (err) {
        if (err instanceof CoercionError) {
          return Promise.resolve(rt.fail(node.id, `${a.variable}: not a valid ${err.type}`));
        }
        throw err;
      }
    }
    return Promise.resolve({ exit: 'next' });
  },
};
