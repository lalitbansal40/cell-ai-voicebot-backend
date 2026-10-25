import { registry } from '../../shared/openapi/registry';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { CallingSettingsPatch, ProgramBody } from './calling.schema';

export const CallingParams = z.object({ id: ObjectIdSchema });
export const PermissionQuery = z.object({
  channelId: ObjectIdSchema,
  contactId: ObjectIdSchema,
  refresh: z.enum(['true', 'false']).optional(),
});
export const PermissionRequestBody = z.object({
  channelId: ObjectIdSchema,
  contactId: ObjectIdSchema,
  body: z.string().trim().min(1).max(1024).optional(),
});
export const StartWhatsAppCallBody = z
  .object({
    channelId: ObjectIdSchema,
    contactId: ObjectIdSchema,
    mode: z.enum(['human', 'ai']),
    program: ProgramBody.nullable().optional(),
  })
  .refine((b) => b.mode !== 'ai' || Boolean(b.program), {
    path: ['program'],
    message: 'Choose a flow or an AI agent',
  });
export const CallHoldBody = z.object({ on: z.boolean() });
export const CallTransferBody = z.object({ userId: ObjectIdSchema.optional() });

export const CallingSettingsSchema = registry.register(
  'WhatsAppCallingSettings',
  z.object({
    channelId: z.string(),
    status: z.enum(['enabled', 'disabled', 'unavailable']),
    unavailableReason: z.string().nullable(),
    businessCallsAvailable: z.boolean(),
    businessCallsBlockedBy: z.string().nullable(),
    callIconVisibility: z.enum(['DEFAULT', 'DISABLE_ALL']),
    iconCountries: z.array(z.string()),
    callHours: CallingSettingsPatch.shape.callHours.unwrap(),
    callbackPermission: z.boolean(),
    inbound: z.object({
      route: z.enum(['team', 'ai', 'ai_then_team']),
      aiProgram: ProgramBody.nullable(),
      ringTimeoutSec: z.number(),
      ringUserIds: z.array(z.string()).nullable(),
    }),
    permissionRequestBody: z.string(),
    restrictions: z.array(
      z.object({
        type: z.string(),
        reason: z.string().nullable(),
        expiresAt: z.string().nullable(),
        active: z.boolean(),
      }),
    ),
    syncedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
);

export const CallPermissionSchema = registry.register(
  'WhatsAppCallPermission',
  z.object({
    status: z.enum([
      'none',
      'requested',
      'temporary',
      'permanent',
      'declined',
      'expired',
      'revoked',
    ]),
    expiresAt: z.string().nullable(),
    canCall: z.boolean(),
    canRequest: z.boolean(),
    nextRequestAt: z.string().nullable(),
    reason: z.string().nullable(),
    history: z.array(z.object({ status: z.string(), at: z.string(), source: z.string() })),
  }),
);
export const CallMediaTicketSchema = registry.register(
  'WhatsAppCallMediaTicket',
  z.object({
    callId: z.string(),
    mediaTicket: z.string(),
    expiresAt: z.string(),
    wsPath: z.string(),
  }),
);
