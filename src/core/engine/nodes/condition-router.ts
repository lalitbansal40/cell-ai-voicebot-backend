import { pickRule } from '../conditions';
import type { NodeHandler } from '../runtime';

/** First matching rule (in order) → `rule_<id>`, else `else`. */
export const conditionRouterNode: NodeHandler<'condition_router'> = {
  enter: (node, rt) =>
    Promise.resolve({
      exit: pickRule(node.config.rules, (c) => ({
        left: rt.getVar(c.variable),
        right: c.value === null ? null : rt.render(c.value, node.id),
      })),
    }),
};
