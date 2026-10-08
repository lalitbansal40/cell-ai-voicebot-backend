import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi';

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument();

  it('is an OpenAPI 3.1 document', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toBe('Cell AI Voicebot API');
  });

  it('documents GET /api/v1/system/info', () => {
    expect(doc.paths?.['/api/v1/system/info']?.get).toBeDefined();
  });

  it('registers the shared components', () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'AppInfo',
      'ErrorEnvelope',
      'ErrorDetail',
      'OffsetPageMeta',
      'CursorPageMeta',
    ]) {
      expect(schemas).toHaveProperty(name);
    }
  });

  it('declares both auth schemes', () => {
    expect(doc.components?.securitySchemes).toHaveProperty('bearerAuth');
    expect(doc.components?.securitySchemes).toHaveProperty('apiKeyAuth');
  });
});
