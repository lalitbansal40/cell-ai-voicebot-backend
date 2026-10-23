import { stringify } from 'csv-stringify';
import { Router, type RequestHandler } from 'express';
import multer, { memoryStorage, MulterError } from 'multer';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { created, ok } from '../../shared/http/envelope';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { formatRupees } from '../../shared/money';

import { BillingSettingsBody, MonthQuery, SaveRateCardBody } from './admin.schema';
import {
  getBillingSettings,
  listRateCards,
  marginReport,
  previewRateCardImport,
  reconciliationReport,
  saveRateCard,
  updateBillingSettings,
} from './admin.service';

const csvUpload = multer({
  storage: memoryStorage(),
  limits: { fileSize: WHATSAPP_BILLING_LIMITS.csvMaxBytes, files: 1, fields: 0, parts: 1 },
}).single('file');
const uploadCsv: RequestHandler = (req, res, next) => {
  csvUpload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('PAYLOAD_TOO_LARGE', 'The rate card file is larger than 2 MB')
          : new ValidationError([{ path: 'file', message: 'Upload one CSV named "file"' }]),
      );
      return;
    }
    next(err);
  });
};

/**
 * Superadmin WhatsApp billing (PHASE_11_PLAN §1m), mounted inside `/api/v1/admin`
 * (already behind `requirePlatformAdmin`); every route needs `platform.billing.manage`.
 */
export const createWhatsAppBillingAdminRouter = (): Router => {
  const router = Router();
  const manage = requirePermission('platform.billing.manage');

  router.get('/whatsapp-rates', manage, async (_req, res) => {
    ok(res, await listRateCards());
  });
  router.post('/whatsapp-rates/import', manage, uploadCsv, async (req, res) => {
    if (!req.file)
      throw new ValidationError([{ path: 'file', message: 'Upload one CSV named "file"' }]);
    ok(res, await previewRateCardImport(req.file.buffer));
  });
  router.post(
    '/whatsapp-rates',
    manage,
    ...handle({ body: SaveRateCardBody }, async ({ body, req, res }) => {
      created(
        res,
        await saveRateCard(req, {
          markets: body.markets,
          source: body.source,
          note: body.note ?? null,
          ...(body.effectiveFrom ? { effectiveFrom: new Date(body.effectiveFrom) } : {}),
        }),
      );
    }),
  );
  router.get('/whatsapp-billing', manage, async (_req, res) => {
    ok(res, await getBillingSettings());
  });
  router.patch(
    '/whatsapp-billing',
    manage,
    ...handle({ body: BillingSettingsBody }, async ({ body, req, res }) => {
      ok(res, await updateBillingSettings(req, body));
    }),
  );
  router.get(
    '/reports/whatsapp-margin',
    manage,
    ...handle({ query: MonthQuery }, async ({ query, res }) => {
      // superadmin report: an optional filter on any customer account (not the caller's tenant)
      const { month, accountId: reportAccount } = query;
      const rows = await marginReport(month, reportAccount);
      if (query.format !== 'csv') {
        ok(res, rows);
        return;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="whatsapp-margin-${query.month}.csv"`,
      );
      const csv = stringify({ header: true, record_delimiter: '\r\n' });
      csv.pipe(res);
      for (const r of rows) {
        csv.write({
          Account: r.accountName,
          Category: r.category,
          Messages: r.messages,
          'Billed (INR)': formatRupees(r.billedMicros).replace(/,/g, ''),
          'Meta cost (INR)': formatRupees(r.metaCostMicros).replace(/,/g, ''),
          'Meta cost source': r.metaCostSource,
          'Margin (INR)': formatRupees(r.marginMicros).replace(/,/g, ''),
          'Margin %': r.marginBps === null ? '' : (r.marginBps / 100).toString(),
          Mismatches: r.mismatches,
        });
      }
      csv.end();
    }),
  );
  router.get(
    '/reports/whatsapp-reconciliation',
    manage,
    ...handle({ query: MonthQuery }, async ({ query, res }) => {
      ok(res, await reconciliationReport(query.month));
    }),
  );
  return router;
};
