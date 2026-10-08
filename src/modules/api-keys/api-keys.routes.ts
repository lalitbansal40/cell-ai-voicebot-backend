import { Router } from 'express';

import { requireAuth } from '../../shared/auth/auth-context';
import { created, noContent, ok } from '../../shared/http/envelope';
import { apiKeyAuth } from '../../shared/middlewares/api-key-auth';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { ApiKeyIdParams, CreateApiKeyBody } from './api-keys.schema';
import { createApiKey, listApiKeys, revokeApiKey } from './api-keys.service';

/** `/api/v1/api-keys` — dashboard management + `whoami` for key holders. */
export const createApiKeysRouter = (): Router => {
  const router = Router();

  // Public-API check: authenticated with the key itself (registered before `:id`).
  router.get('/whoami', apiKeyAuth(), (req, res) => {
    const auth = requireAuth(req);
    ok(res, {
      accountId: auth.accountId,
      apiKeyId: auth.apiKeyId ?? '',
      scopes: [...(auth.scopes ?? [])],
    });
  });

  router.get('/', authenticate(), requirePermission('apikeys.read'), async (req, res) => {
    ok(res, await listApiKeys(req));
  });
  router.post(
    '/',
    authenticate(),
    requirePermission('apikeys.manage'),
    blockWhenImpersonating(),
    ...handle({ body: CreateApiKeyBody }, async ({ body, req, res }) => {
      res.set('Cache-Control', 'no-store');
      created(res, await createApiKey(req, body));
    }),
  );
  router.delete(
    '/:id',
    authenticate(),
    requirePermission('apikeys.manage'),
    ...handle({ params: ApiKeyIdParams }, async ({ params, req, res }) => {
      await revokeApiKey(req, params.id);
      noContent(res);
    }),
  );
  return router;
};
