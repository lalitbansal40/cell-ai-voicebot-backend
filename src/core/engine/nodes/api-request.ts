import { pickPath } from '../../ai/http-tool';
import type { NodeHandler } from '../runtime';
import { coerce } from '../variables';

/** Calls the client system; 2xx → `success` (fields saved), other status → `failure`, no answer → `error`. */
export const apiRequestNode: NodeHandler<'api_request'> = {
  enter: async (node, rt) => {
    const result = await rt.effects.callApi({
      nodeId: node.id,
      config: node.config,
      values: rt.values(),
    });
    if (!result.ok) return rt.fail(node.id, `API request failed (${result.error})`);
    rt.setVar('last_api_status', result.status);
    if (result.status < 200 || result.status >= 300) return { exit: 'failure' };
    for (const { path, variable } of node.config.saveResponse) {
      const raw = pickPath(result.body, path);
      const type = rt.varType(variable);
      const flowType = type === 'number' || type === 'boolean' || type === 'date' ? type : 'text';
      try {
        if (raw === undefined) throw new Error('missing');
        rt.setVar(
          variable,
          coerce(flowType, typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : raw),
        );
      } catch {
        rt.setVar(variable, null);
        rt.note(
          node.id,
          `Response field ${path} missing or not a ${flowType} — ${variable} cleared`,
        );
      }
    }
    return { exit: 'success' };
  },
};
