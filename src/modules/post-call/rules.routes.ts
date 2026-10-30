import { Router } from 'express';

import { created, noContent, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { CreateRuleBody, RuleParams, UpdateRuleBody } from './rules.schema';
import { createRule, deleteRule, getAfterCall, listRules, updateRule } from './rules.service';

/** `/api/v1/outcome-rules` — "After the call" rules (owners / admins, dashboard only). */
export const createOutcomeRulesRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  const manage = requirePermission('integrations.manage');
  const change = [manage, blockWhenImpersonating()];
  router.get('/', manage, async (req, res) => {
    ok(res, await listRules(req));
  });
  router.post(
    '/',
    ...change,
    ...handle({ body: CreateRuleBody }, async ({ body, req, res }) => {
      created(res, await createRule(req, body));
    }),
  );
  router.patch(
    '/:id',
    ...change,
    ...handle({ params: RuleParams, body: UpdateRuleBody }, async ({ params, body, req, res }) => {
      ok(res, await updateRule(req, params.id, body));
    }),
  );
  router.delete(
    '/:id',
    ...change,
    ...handle({ params: RuleParams }, async ({ params, req, res }) => {
      await deleteRule(req, params.id);
      noContent(res);
    }),
  );
  return router;
};

/** `GET /api/v1/calls/:id/after-call` (calls.read / calls:read). */
export const createAfterCallRouter = (): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  router.get(
    '/:id/after-call',
    access({ permission: 'calls.read', scope: 'calls:read' }),
    ...handle({ params: RuleParams }, async ({ params, req, res }) => {
      ok(res, await getAfterCall(req, params.id));
    }),
  );
  return router;
};
