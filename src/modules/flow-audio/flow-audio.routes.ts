import { Router, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import multer, { memoryStorage, MulterError } from 'multer';

import { FLOW_LIMITS } from '../../config/limits';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AudioParams,
  ListAudioQuery,
  RenameAudioBody,
  UploadAudioFields,
} from './flow-audio.schema';
import {
  audioUrl,
  deleteAudio,
  listAudio,
  renameAudio,
  uploadAudio,
  type FlowAudioDeps,
  type UploadedAudio,
} from './flow-audio.service';

const upload = multer({
  storage: memoryStorage(),
  limits: { fileSize: FLOW_LIMITS.audioMaxBytes, files: 1, fields: 1, parts: 2 },
}).single('file');

/** multer → our envelope: too large = 413, odd parts = 422. */
const uploadFile: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than 5 MB.')
          : new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]),
      );
      return;
    }
    next(err);
  });
};

/** `/api/v1/flow-audio` — account audio library for call flows. */
export const createFlowAudioRouter = (deps: FlowAudioDeps & { uploadStore?: Store }): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('flows.read');
  const write = [requirePermission('flows.write'), blockWhenImpersonating()];
  const uploadLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    limit: FLOW_LIMITS.audioUploadsPerHour,
    keyGenerator: (req) => `flowaudio:${req.auth?.accountId ?? 'anonymous'}`,
    ...(deps.uploadStore ? { store: deps.uploadStore } : {}),
  });

  router.get(
    '/',
    read,
    ...handle({ query: ListAudioQuery }, async ({ query, req, res }) => {
      ok(res, await listAudio(req, query.q));
    }),
  );
  router.post(
    '/',
    ...write,
    uploadLimiter,
    uploadFile,
    ...handle({ body: UploadAudioFields }, async ({ body, req, res }) => {
      const file = (req as unknown as { file?: UploadedAudio }).file;
      created(res, await uploadAudio(req, file, body.name, deps));
    }),
  );
  router.get(
    '/:id/url',
    read,
    ...handle({ params: AudioParams }, async ({ params, req, res }) => {
      ok(res, await audioUrl(req, params.id, deps));
    }),
  );
  router.patch(
    '/:id',
    ...write,
    ...handle(
      { params: AudioParams, body: RenameAudioBody },
      async ({ params, body, req, res }) => {
        ok(res, await renameAudio(req, params.id, body.name));
      },
    ),
  );
  router.delete(
    '/:id',
    ...write,
    ...handle({ params: AudioParams }, async ({ params, req, res }) => {
      await deleteAudio(req, params.id);
      noContent(res);
    }),
  );
  return router;
};
