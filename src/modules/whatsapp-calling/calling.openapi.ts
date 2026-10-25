import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { CallSchema } from '../calls/calls.schema';

import {
  CallingParams,
  CallingSettingsSchema,
  CallPermissionSchema,
  CallMediaTicketSchema,
  PermissionQuery,
  PermissionRequestBody,
  StartWhatsAppCallBody,
  CallHoldBody,
  CallTransferBody,
} from './calling-api.schema';
import { CallAvailabilityBody, CallingSettingsPatch } from './calling.schema';

const tags = ['WhatsApp calling'];
const failures = {
  401: errors[401],
  403: errors[403],
  404: errors[404],
  409: errors[409],
  422: errors[422],
  429: errors[429],
  503: { description: 'WhatsApp calling or media capacity unavailable' },
};
const body = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const settingsPath = '/api/v1/whatsapp/channels/{id}/calling';
registry.registerPath({
  method: 'get',
  path: settingsPath,
  tags,
  security: bearer,
  summary: 'Calling settings and restrictions (calls.read)',
  request: { params: CallingParams },
  responses: { 200: ok(CallingSettingsSchema), ...failures },
});
registry.registerPath({
  method: 'patch',
  path: settingsPath,
  tags,
  security: bearer,
  summary: 'Update calling settings and sync with Meta (whatsapp.calling.manage)',
  request: { params: CallingParams, body: body(CallingSettingsPatch) },
  responses: { 200: ok(CallingSettingsSchema), ...failures },
});
registry.registerPath({
  method: 'post',
  path: `${settingsPath}/sync`,
  tags,
  security: bearer,
  summary: 'Refresh settings and restrictions from Meta (whatsapp.calling.manage)',
  request: { params: CallingParams },
  responses: { 200: ok(CallingSettingsSchema), ...failures },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/whatsapp/call-permissions',
  tags,
  security: bearer,
  summary: 'Contact call permission, eligibility and history (calls.read)',
  request: { query: PermissionQuery },
  responses: { 200: ok(CallPermissionSchema), ...failures },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/whatsapp/call-permissions/request',
  tags,
  security: bearer,
  summary: 'Request permission in-window or by approved template (inbox.reply; 20/hour/user)',
  request: { body: body(PermissionRequestBody) },
  responses: {
    201: ok(z.object({ messageId: z.string(), kind: z.enum(['interactive', 'template']) })),
    ...failures,
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/whatsapp/calls',
  tags,
  security: bearer,
  summary: 'Place a human or AI WhatsApp call (calls.trigger; 10/minute/user; Idempotency-Key)',
  request: {
    headers: z.object({ 'idempotency-key': z.string() }),
    body: body(StartWhatsAppCallBody),
  },
  responses: {
    201: ok(
      z.object({
        callId: z.string(),
        call: CallSchema,
        mediaTicket: z.string().optional(),
        expiresAt: z.string().optional(),
        wsPath: z.string().optional(),
      }),
    ),
    ...failures,
  },
});
for (const action of ['answer', 'decline', 'hold', 'transfer'] as const) {
  registry.registerPath({
    method: 'post',
    path: `/api/v1/whatsapp/calls/{id}/${action}`,
    tags,
    security: bearer,
    summary: `${action} a WhatsApp call (answer/decline: calls.answer; hold: calls.trigger; transfer: calls.listen)`,
    request: {
      params: CallingParams,
      ...(action === 'hold'
        ? { body: body(CallHoldBody) }
        : action === 'transfer'
          ? { body: body(CallTransferBody) }
          : {}),
    },
    responses: {
      200: ok(
        action === 'answer'
          ? CallMediaTicketSchema
          : action === 'decline'
            ? z.object({ declined: z.boolean() })
            : action === 'hold'
              ? z.object({ onHold: z.boolean() })
              : z.object({ callId: z.string(), ringing: z.boolean() }),
      ),
      ...failures,
    },
  });
}
registry.registerPath({
  method: 'post',
  path: '/api/v1/calls/{id}/media-ticket',
  tags,
  security: bearer,
  summary: 'Single-use media ticket for the assigned human agent (calls.answer)',
  request: { params: CallingParams },
  responses: { 200: ok(CallMediaTicketSchema), ...failures },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/users/me/call-availability',
  tags,
  security: bearer,
  summary: 'Set your availability for incoming calls (calls.answer)',
  request: { body: body(CallAvailabilityBody) },
  responses: { 200: ok(CallAvailabilityBody), ...failures },
});
