import { Router } from 'express';

import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CreateSegmentBody,
  ListSegmentsQuery,
  PreviewSegmentBody,
  SegmentIdParams,
  UpdateSegmentBody,
} from './segments.schema';
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  previewSegment,
  updateSegment,
} from './segments.service';

/** `/api/v1/segments` — saved contact filters. */
export const createSegmentsRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get(
    '/',
    requirePermission('contacts.read'),
    ...handle({ query: ListSegmentsQuery }, async ({ query, req, res }) => {
      ok(res, await listSegments(req, { withCounts: query.withCounts }));
    }),
  );
  router.post(
    '/preview',
    requirePermission('contacts.read'),
    ...handle({ body: PreviewSegmentBody }, async ({ body, req, res }) => {
      ok(res, await previewSegment(req, body.filter));
    }),
  );
  router.post(
    '/',
    requirePermission('contacts.write'),
    ...handle({ body: CreateSegmentBody }, async ({ body, req, res }) => {
      created(res, await createSegment(req, body));
    }),
  );
  router.get(
    '/:id',
    requirePermission('contacts.read'),
    ...handle({ params: SegmentIdParams }, async ({ params, req, res }) => {
      ok(res, await getSegment(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    requirePermission('contacts.write'),
    ...handle(
      { params: SegmentIdParams, body: UpdateSegmentBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateSegment(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    requirePermission('contacts.write'),
    ...handle({ params: SegmentIdParams }, async ({ params, req, res }) => {
      await deleteSegment(req, params.id);
      noContent(res);
    }),
  );
  return router;
};
