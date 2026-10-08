import { Router } from 'express';

import { accepted, created, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { unavailableContactJobs, type ContactJobs } from '../contacts/jobs';

import {
  CreateCustomFieldBody,
  CustomFieldIdParams,
  ListCustomFieldsQuery,
  ReorderCustomFieldsBody,
  UpdateCustomFieldBody,
} from './custom-fields.schema';
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  reorderCustomFields,
  updateCustomField,
} from './custom-fields.service';

/** `/api/v1/custom-fields` — typed contact variables (`{{key}}` in flows). */
export const createCustomFieldsRouter = ({
  jobs = unavailableContactJobs,
}: { jobs?: ContactJobs } = {}): Router => {
  const router = Router();
  router.use(authenticate());

  router.get(
    '/',
    requirePermission('contacts.read'),
    ...handle({ query: ListCustomFieldsQuery }, async ({ query, req, res }) => {
      ok(res, await listCustomFields(req, { withUsage: query.withUsage }));
    }),
  );
  router.post(
    '/',
    requirePermission('contacts.write'),
    ...handle({ body: CreateCustomFieldBody }, async ({ body, req, res }) => {
      created(res, await createCustomField(req, body));
    }),
  );
  router.put(
    '/order',
    requirePermission('contacts.write'),
    ...handle({ body: ReorderCustomFieldsBody }, async ({ body, req, res }) => {
      ok(res, await reorderCustomFields(req, body.ids));
    }),
  );
  router.patch(
    '/:id',
    requirePermission('contacts.write'),
    ...handle(
      { params: CustomFieldIdParams, body: UpdateCustomFieldBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateCustomField(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    requirePermission('contacts.write'),
    ...handle({ params: CustomFieldIdParams }, async ({ params, req, res }) => {
      await deleteCustomField(req, params.id, jobs);
      accepted(res, { jobQueued: true as const });
    }),
  );
  return router;
};
