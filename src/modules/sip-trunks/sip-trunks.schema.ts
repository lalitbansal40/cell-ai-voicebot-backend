import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

/** An account's own SIP trunk (Admin → account → Phone line). */

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Must be an id');
const HOST = /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9-]{1,63}$|^(\d{1,3}\.){3}\d{1,3}$/;
const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

export const SipTrunkParams = z.strictObject({ id: objectId });

export const SipTrunkBody = z
  .strictObject({
    host: z.string().trim().regex(HOST, 'A host name or IP address, e.g. sip.carrier.in'),
    port: z.number().int().min(1).max(65535).default(5060),
    transport: z.enum(['udp', 'tcp']).default('udp'),
    auth: z.enum(['ip', 'register']),
    username: z.string().trim().min(1).max(80).nullable().optional(),
    /** Omit to keep the saved password. */
    password: z.string().min(1).max(200).optional(),
    trunkIps: z
      .array(z.string().trim().regex(IP_OR_CIDR, 'An IP address or range'))
      .max(20)
      .default([]),
    callerId: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +911600000000'),
    codecs: z
      .array(z.enum(['ulaw', 'alaw']))
      .min(1)
      .max(2)
      .default(['ulaw', 'alaw']),
  })
  .superRefine((b, ctx) => {
    if (b.auth === 'register' && !b.username)
      ctx.addIssue({ code: 'custom', path: ['username'], message: 'Enter the trunk username' });
  })
  .openapi('SipTrunkBody');

export const SipTrunkSchema = registry.register(
  'SipTrunk',
  z.object({
    configured: z.boolean(),
    trunk: z
      .object({
        host: z.string(),
        port: z.number(),
        transport: z.enum(['udp', 'tcp']),
        auth: z.enum(['ip', 'register']),
        username: z.string().nullable(),
        passwordSet: z.boolean(),
        trunkIps: z.array(z.string()),
        callerId: z.string(),
        codecs: z.array(z.enum(['ulaw', 'alaw'])),
        updatedAt: z.string(),
      })
      .nullable(),
    /** `online` / `offline` / `unknown` (Asterisk's check), `not_loaded`, `line_down`. */
    state: z.string().nullable(),
    lineConnected: z.boolean(),
  }),
);

const tags = ['Admin'];
const path = '/api/v1/admin/accounts/{id}/sip-trunk';
const req = { params: SipTrunkParams };

registry.registerPath({
  method: 'get',
  path,
  tags,
  summary: "The account's own SIP trunk and whether it is reachable (superadmin)",
  security: bearer,
  request: req,
  responses: { 200: ok(SipTrunkSchema), 403: errors[403], 404: errors[404] },
});
registry.registerPath({
  method: 'put',
  path,
  tags,
  summary:
    "Save the account's own SIP trunk and connect it — no env change; puts the account on the phone line and gives it the caller ID (superadmin)",
  security: bearer,
  request: { ...req, body: { content: { 'application/json': { schema: SipTrunkBody } } } },
  responses: {
    200: ok(SipTrunkSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'delete',
  path,
  tags,
  summary: "Remove the account's own SIP trunk (calls use the server trunk again; superadmin)",
  security: bearer,
  request: req,
  responses: { 200: ok(SipTrunkSchema), 403: errors[403], 404: errors[404] },
});
