import { Router, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import multer, { memoryStorage, MulterError } from 'multer';

import { AI_LIMITS } from '../../config/limits';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { accepted, created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AddUrlBody,
  CreateKbBody,
  DeleteKbQuery,
  KbParams,
  SearchKbBody,
  SourceParams,
  UpdateKbBody,
} from './knowledge.schema';
import {
  addFiles,
  addUrl,
  createKb,
  deleteKb,
  deleteSource,
  getKb,
  listKbs,
  listSources,
  reindexKb,
  reindexSource,
  searchKb,
  updateKb,
  type KnowledgeDeps,
  type UploadedKnowledgeFile,
} from './knowledge.service';

const upload = multer({
  storage: memoryStorage(),
  limits: {
    fileSize: AI_LIMITS.fileMaxBytes,
    files: AI_LIMITS.filesPerUpload,
    fields: 0,
    parts: AI_LIMITS.filesPerUpload,
  },
}).array('files', AI_LIMITS.filesPerUpload);

/** multer → our envelope: too large = 413, too many / odd parts = 422. */
const uploadFiles: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('PAYLOAD_TOO_LARGE', 'A file is larger than 10 MB.')
          : new ValidationError([
              {
                path: 'files',
                message:
                  err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT'
                    ? `Upload at most ${AI_LIMITS.filesPerUpload} files at a time`
                    : err.message,
              },
            ]),
      );
      return;
    }
    next(err);
  });
};

/** `/api/v1/knowledge-bases` — knowledge bases, their sources and test search. */
export const createKnowledgeRouter = (deps: KnowledgeDeps & { sourcesStore?: Store }): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('agents.read');
  const write = [requirePermission('agents.write'), blockWhenImpersonating()];
  const sourcesLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    limit: AI_LIMITS.kbSourcesPerHour,
    keyGenerator: (req) => `kbsrc:${req.auth?.accountId ?? 'anonymous'}`,
    ...(deps.sourcesStore ? { store: deps.sourcesStore } : {}),
  });

  router.get('/', read, ...handle({}, async ({ req, res }) => ok(res, await listKbs(req, deps))));
  router.post(
    '/',
    ...write,
    ...handle({ body: CreateKbBody }, async ({ body, req, res }) => {
      created(res, await createKb(req, body, deps));
    }),
  );
  router.get(
    '/:id',
    read,
    ...handle({ params: KbParams }, async ({ params, req, res }) => {
      ok(res, await getKb(req, params.id, deps));
    }),
  );
  router.patch(
    '/:id',
    ...write,
    ...handle({ params: KbParams, body: UpdateKbBody }, async ({ params, body, req, res }) => {
      ok(res, await updateKb(req, params.id, body, deps));
    }),
  );
  router.delete(
    '/:id',
    ...write,
    ...handle({ params: KbParams, query: DeleteKbQuery }, async ({ params, query, req, res }) => {
      await deleteKb(req, params.id, query.force ?? false, deps);
      noContent(res);
    }),
  );
  router.get(
    '/:id/sources',
    read,
    ...handle({ params: KbParams }, async ({ params, req, res }) => {
      ok(res, await listSources(req, params.id));
    }),
  );
  router.post(
    '/:id/sources/files',
    ...write,
    sourcesLimiter,
    uploadFiles,
    ...handle({ params: KbParams }, async ({ params, req, res }) => {
      const files = (req.files ?? []) as UploadedKnowledgeFile[];
      accepted(res, await addFiles(req, params.id, files, deps));
    }),
  );
  router.post(
    '/:id/sources/url',
    ...write,
    sourcesLimiter,
    ...handle({ params: KbParams, body: AddUrlBody }, async ({ params, body, req, res }) => {
      accepted(res, await addUrl(req, params.id, body, deps));
    }),
  );
  router.delete(
    '/:id/sources/:sid',
    ...write,
    ...handle({ params: SourceParams }, async ({ params, req, res }) => {
      await deleteSource(req, params.id, params.sid, deps);
      noContent(res);
    }),
  );
  router.post(
    '/:id/sources/:sid/reindex',
    ...write,
    ...handle({ params: SourceParams }, async ({ params, req, res }) => {
      accepted(res, await reindexSource(req, params.id, params.sid, deps));
    }),
  );
  router.post(
    '/:id/reindex',
    ...write,
    ...handle({ params: KbParams }, async ({ params, req, res }) => {
      accepted(res, await reindexKb(req, params.id, deps));
    }),
  );
  router.post(
    '/:id/search',
    read,
    ...handle({ params: KbParams, body: SearchKbBody }, async ({ params, body, req, res }) => {
      ok(res, await searchKb(req, params.id, body, deps));
    }),
  );
  return router;
};
