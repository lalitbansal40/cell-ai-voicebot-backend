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

import {
  ApiKeyIdParams,
  ApiKeyRequestsQuery,
  CreateApiKeyBody,
  scopeCatalogue,
  UpdateApiKeyBody,
} from './api-keys.schema';
import {
  createApiKey,
  listApiKeys,
  listKeyRequests,
  revokeApiKey,
  updateApiKey,
} from './api-keys.service';

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
  router.get('/scopes', authenticate(), requirePermission('apikeys.read'), (_req, res) => {
    ok(res, scopeCatalogue());
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
  router.patch(
    '/:id',
    authenticate(),
    requirePermission('apikeys.manage'),
    blockWhenImpersonating(),
    ...handle(
      { params: ApiKeyIdParams, body: UpdateApiKeyBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateApiKey(req, params.id, body));
      },
    ),
  );
  router.get(
    '/:id/requests',
    authenticate(),
    requirePermission('apikeys.read'),
    ...handle(
      { params: ApiKeyIdParams, query: ApiKeyRequestsQuery },
      async ({ params, query, req, res }) => {
        ok(res, await listKeyRequests(req, params.id, query));
      },
    ),
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
