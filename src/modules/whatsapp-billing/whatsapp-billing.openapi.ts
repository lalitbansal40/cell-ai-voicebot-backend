import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';

import { PricePreviewBody, PricePreviewSchema } from './price-preview.schema';

const tags = ['WhatsApp billing'];

registry.registerPath({
  method: 'post',
  path: '/api/v1/whatsapp/price-preview',
  tags,
  summary:
    'Price of one WhatsApp message to a contact / phone: template category or service (inbox.read or templates.read)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: PricePreviewBody } } } },
  responses: {
    200: ok(PricePreviewSchema),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});
