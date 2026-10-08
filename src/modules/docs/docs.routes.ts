import { Router, static as serveStatic } from 'express';

import { docsCsp } from '../../shared/middlewares/security';

import { DOCS_INIT_JS, DOCS_PATH, renderDocsPage } from './docs.page';

// The package's index.js `require`s the 1.5 MB browser bundle; we only need the path.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS-only helper, no types
const getAbsoluteFSPath = require('swagger-ui-dist/absolute-path.js') as () => string;

/** Files in swagger-ui-dist that boot the Petstore demo — never served. */
const BLOCKED_ASSETS = new Set(['/index.html', '/swagger-initializer.js']);

/**
 * Swagger UI at /api/docs (only when API_DOCS_ENABLED). Own HTML + init script,
 * static assets from `swagger-ui-dist`, strict CSP on these routes only.
 */
export const createDocsRouter = (): Router => {
  const router = Router();
  router.use(DOCS_PATH, docsCsp());

  const page = renderDocsPage();
  router.get([DOCS_PATH, `${DOCS_PATH}/`], (_req, res) => {
    res.type('html').send(page);
  });
  router.get(`${DOCS_PATH}/init.js`, (_req, res) => {
    res.type('application/javascript').send(DOCS_INIT_JS);
  });
  router.use(
    `${DOCS_PATH}/assets`,
    (req, _res, next) => {
      if (BLOCKED_ASSETS.has(req.path)) next('router');
      else next();
    },
    serveStatic(getAbsoluteFSPath(), { index: false, maxAge: '1d', fallthrough: true }),
  );
  return router;
};
