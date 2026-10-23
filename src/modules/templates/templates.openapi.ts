import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

import {
  CallPermissionBody,
  CreateTemplateBody,
  DeleteTemplateQuery,
  EditTemplateBody,
  ListTemplatesQuery,
  SyncResultSchema,
  SyncTemplatesBody,
  TemplateDetailSchema,
  TemplateListItemSchema,
  TemplateParams,
  VariableSourcesBody,
} from './templates.schema';

const tags = ['WhatsApp templates'];
const base = '/api/v1/whatsapp/templates';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const notSetUp = {
  503: { description: "WhatsApp isn't set up on this server (WHATSAPP_NOT_CONFIGURED)" },
};
const reads = { 401: errors[401], 403: errors[403], 404: errors[404], ...notSetUp };
const writes = {
  ...reads,
  409: errors[409],
  422: errors[422],
  429: errors[429],
  502: { description: 'Meta refused (META_API_ERROR)' },
};

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Templates of the account — list rows carry no bodies or examples (templates.read)',
  security: bearer,
  request: { query: ListTemplatesQuery },
  responses: { 200: ok(z.array(TemplateListItemSchema)), ...reads },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary:
    'Create a template: draft (`submit: false`) or submitted to Meta (templates.manage, rl:templates: 20 / h / user)',
  security: bearer,
  request: json(CreateTemplateBody),
  responses: { 201: ok(TemplateDetailSchema, 'Created'), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/sync`,
  tags,
  summary: "Sync the number's WABA templates from Meta (templates.manage, 1 / min / number)",
  security: bearer,
  request: json(SyncTemplatesBody),
  responses: { 200: ok(SyncResultSchema), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/call-permission`,
  tags,
  summary:
    'The ready-made "may we call you?" template — utility, one per number × language (templates.manage)',
  security: bearer,
  request: json(CallPermissionBody),
  responses: { 201: ok(TemplateDetailSchema, 'Created'), ...writes },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}`,
  tags,
  summary:
    'Template detail: components, variables + sources, history, usage, edit window (templates.read)',
  security: bearer,
  request: { params: TemplateParams },
  responses: { 200: ok(TemplateDetailSchema), ...reads },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary:
    'Edit — drafts freely; Meta templates when approved / rejected / paused (approved: 1 / 24 h, 10 / 30 days, category fixed) (templates.manage)',
  security: bearer,
  request: { params: TemplateParams, ...json(EditTemplateBody) },
  responses: { 200: ok(TemplateDetailSchema), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/submit`,
  tags,
  summary: 'Submit a draft to Meta for review (templates.manage)',
  security: bearer,
  request: { params: TemplateParams },
  responses: { 200: ok(TemplateDetailSchema), ...writes },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary:
    'Delete at Meta — this language or every language of the name; rows stay as DELETED, the name is locked 30 days (templates.manage)',
  security: bearer,
  request: { params: TemplateParams, query: DeleteTemplateQuery },
  responses: { 200: ok(z.object({ deleted: z.number() })), ...writes },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}/variables`,
  tags,
  summary:
    'Default source per variable: contact name / phone / email, a custom field, a text, ask (templates.manage)',
  security: bearer,
  request: { params: TemplateParams, ...json(VariableSourcesBody) },
  responses: { 200: ok(TemplateDetailSchema), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/media`,
  tags,
  summary:
    'Media header example (multipart `file`: JPEG / PNG 5 MB, MP4 16 MB, PDF 100 MB) → storage + Meta handle (templates.manage)',
  security: bearer,
  request: {
    params: TemplateParams,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.string().openapi({ format: 'binary' }) }),
        },
      },
    },
  },
  responses: { 200: ok(TemplateDetailSchema), ...writes, 413: errors[413] },
});
