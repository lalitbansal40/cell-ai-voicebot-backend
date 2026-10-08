import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { getAppInfo } from './shared/app-info';
import { registry } from './shared/openapi/registry';

// Module schemas register their paths/components on import. Add every module
// with API routes here.
import './modules/account/account.schema';
import './modules/auth/auth.schema';
import './modules/health/health.schema';
import './modules/rbac/rbac.schema';
import './modules/system/system.schema';

type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export const DEFAULT_SERVER_URL = 'http://localhost:5100';

/**
 * Builds the OpenAPI 3.1 document for the whole API (ADR 0029). The committed
 * file (`npm run gen:openapi`) uses the local server URL; the served copy
 * (`GET /api/v1/openapi.json`) uses `APP_URL`.
 */
export const buildOpenApiDocument = ({
  serverUrl = DEFAULT_SERVER_URL,
}: { serverUrl?: string } = {}): OpenApiDocument =>
  new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Cell AI Voicebot API',
      version: getAppInfo().version,
      description:
        'Multi-tenant AI voice calling platform API. Conventions: docs/conventions/api.md.',
    },
    servers: [
      {
        url: serverUrl,
        description: serverUrl === DEFAULT_SERVER_URL ? 'Local development' : 'This server',
      },
    ],
  });
