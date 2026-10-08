import { Router, type RequestHandler } from 'express';
import multer, { memoryStorage, MulterError } from 'multer';

import { CONTACT_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { accepted, created, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { unavailableContactJobs, type ContactJobs } from '../contacts/jobs';

import {
  ImportIdParams,
  ListImportsQuery,
  SetMappingBody,
  UploadFields,
} from './contact-imports.schema';
import {
  cancelImport,
  errorReportUrl,
  getImport,
  importTemplate,
  listImports,
  setMapping,
  startImport,
  startValidation,
  uploadImport,
  type UploadedFile,
} from './contact-imports.service';

const upload = multer({
  storage: memoryStorage(),
  limits: { fileSize: CONTACT_LIMITS.importMaxBytes, files: 1, fields: 5, parts: 7 },
}).single('file');

/** multer → our error envelope: too large = 413, other upload problems = 422. */
export const uploadFile: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than 10 MB.')
          : new ValidationError([{ path: err.field ?? 'file', message: err.message }]),
      );
      return;
    }
    next(err);
  });
};

/** `/api/v1/contact-imports` — upload → map → validate → import. */
export const createContactImportsRouter = ({
  storage,
  jobs = unavailableContactJobs,
}: { storage?: StorageProvider; jobs?: ContactJobs } = {}): Router => {
  const router = Router();
  const files = (): StorageProvider => {
    if (!storage) throw new Error('File storage is not configured');
    return storage;
  };
  router.use(authenticate());

  router.post(
    '/',
    requirePermission('contacts.import'),
    uploadFile,
    ...handle({ body: UploadFields }, async ({ body, req, res }) => {
      created(
        res,
        await uploadImport(req, req.file as UploadedFile | undefined, body.kind, files()),
      );
    }),
  );
  router.get(
    '/',
    requirePermission('contacts.read'),
    ...handle({ query: ListImportsQuery }, async ({ query, req, res }) => {
      const page = await listImports(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get('/template.csv', requirePermission('contacts.import'), async (req, res) => {
    res
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="contacts-template.csv"')
      .send(await importTemplate(req));
  });
  router.get(
    '/:id',
    requirePermission('contacts.read'),
    ...handle({ params: ImportIdParams }, async ({ params, req, res }) => {
      ok(res, await getImport(req, params.id));
    }),
  );
  router.put(
    '/:id/mapping',
    requirePermission('contacts.import'),
    ...handle(
      { params: ImportIdParams, body: SetMappingBody },
      async ({ params, body, req, res }) => {
        ok(res, await setMapping(req, params.id, body, files()));
      },
    ),
  );
  router.post(
    '/:id/validate',
    requirePermission('contacts.import'),
    ...handle({ params: ImportIdParams }, async ({ params, req, res }) => {
      accepted(res, await startValidation(req, params.id, jobs));
    }),
  );
  router.post(
    '/:id/start',
    requirePermission('contacts.import'),
    ...handle({ params: ImportIdParams }, async ({ params, req, res }) => {
      accepted(res, await startImport(req, params.id, jobs));
    }),
  );
  router.post(
    '/:id/cancel',
    requirePermission('contacts.import'),
    ...handle({ params: ImportIdParams }, async ({ params, req, res }) => {
      ok(res, await cancelImport(req, params.id, files()));
    }),
  );
  router.get(
    '/:id/error-report',
    requirePermission('contacts.read'),
    ...handle({ params: ImportIdParams }, async ({ params, req, res }) => {
      ok(res, await errorReportUrl(req, params.id, files()));
    }),
  );
  return router;
};
