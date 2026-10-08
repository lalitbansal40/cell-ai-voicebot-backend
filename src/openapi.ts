import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { registry } from './shared/openapi/registry';

// Module schemas register their paths/components on import. Add every module
// with API routes here.
import './modules/health/health.schema';
import './modules/system/system.schema';

type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/** Builds the OpenAPI 3.1 document for the whole API (ADR 0029). */
export const buildOpenApiDocument = (): OpenApiDocument =>
  new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Cell AI Voicebot API',
      version: process.env.npm_package_version ?? '0.0.0-dev',
      description:
        'Multi-tenant AI voice calling platform API. Conventions: docs/conventions/api.md.',
    },
    servers: [{ url: 'http://localhost:5100', description: 'Local development' }],
  });
