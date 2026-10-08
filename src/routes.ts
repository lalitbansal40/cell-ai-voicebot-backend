import { Router } from 'express';

import type { Env } from './config/env';
import type { StorageProvider } from './core/storage';
import { createAccountRouter } from './modules/account/account.routes';
import { createAdminRouter } from './modules/admin/admin.routes';
import { createApiKeysRouter } from './modules/api-keys/api-keys.routes';
import { createAuditRouter } from './modules/audit/audit.routes';
import { createAuthRouter, type AuthRouterDeps } from './modules/auth/auth.routes';
import { createContactImportsRouter } from './modules/contact-imports/contact-imports.routes';
import { createContactListsRouter } from './modules/contact-lists/contact-lists.routes';
import { createContactTagsRouter, createContactsRouter } from './modules/contacts/contacts.routes';
import type { ContactJobs } from './modules/contacts/jobs';
import { createCustomFieldsRouter } from './modules/custom-fields/custom-fields.routes';
import { createDndRouter, createOptOutRouter } from './modules/dnd/dnd.routes';
import { createOpenApiHandler } from './modules/docs/openapi.controller';
import { createRbacRouter } from './modules/rbac/rbac.routes';
import { createWsTicketsRouter } from './modules/realtime-tickets/tickets.routes';
import { createSegmentsRouter } from './modules/segments/segments.routes';
import { createSystemRouter } from './modules/system/system.routes';
import { createTeamRouter } from './modules/team/team.routes';

/** Everything under /api/v1. Add each module router here. */
/** What the contact modules need: file storage + the background job queue (Phase 3). */
export interface ContactsDeps {
  storage?: StorageProvider;
  jobs?: ContactJobs;
}

export const createApiRouter = ({
  env,
  auth = {},
  contacts = {},
}: {
  env: Pick<Env, 'APP_URL' | 'CORS_ORIGINS' | 'NODE_ENV'>;
  auth?: Omit<AuthRouterDeps, 'env'>;
  contacts?: ContactsDeps;
}): Router => {
  const router = Router();
  router.use('/auth', createAuthRouter({ ...auth, env }));
  router.use('/account', createAccountRouter());
  router.use('/team', createTeamRouter());
  router.use('/api-keys', createApiKeysRouter());
  router.use('/audit-logs', createAuditRouter());
  router.use('/admin', createAdminRouter());
  router.use('/ws', createWsTicketsRouter());
  router.get('/openapi.json', createOpenApiHandler(env.APP_URL));
  router.use('/system', createSystemRouter());
  router.use('/rbac', createRbacRouter());
  router.use('/contacts', createOptOutRouter());
  router.use('/contacts', createContactsRouter());
  router.use('/dnd-entries', createDndRouter());
  router.use('/contact-tags', createContactTagsRouter());
  router.use('/contact-lists', createContactListsRouter({ jobs: contacts.jobs }));
  router.use('/segments', createSegmentsRouter());
  router.use(
    '/contact-imports',
    createContactImportsRouter({ storage: contacts.storage, jobs: contacts.jobs }),
  );
  router.use('/custom-fields', createCustomFieldsRouter({ jobs: contacts.jobs }));
  return router;
};
