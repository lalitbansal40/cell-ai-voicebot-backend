import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/** Single registry for every schema and path in the public API contract. */
export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Dashboard access token (ADR 0009).',
});

registry.registerComponent('securitySchemes', 'apiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
  description: 'Public API key with scopes (Phase 10).',
});
