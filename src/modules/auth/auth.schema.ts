import { registry } from '../../shared/openapi/registry';
import { errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { PhoneE164Schema } from '../../shared/validation/schemas';
import { isTimezone } from '../../shared/validation/timezone';

export const EmailSchema = z.email().max(254).openapi({ example: 'asha@example.com' });
/** Policy (length, common, email/name) is checked in the service → `body.password` details. */
export const PasswordInputSchema = z.string().min(1).max(256).openapi({ format: 'password' });
export const TimezoneSchema = z
  .string()
  .refine(isTimezone, 'Must be an IANA timezone like Asia/Kolkata')
  .openapi({ example: 'Asia/Kolkata' });

export const SignupBody = z.strictObject({
  businessName: z.string().trim().min(2).max(80).openapi({ example: 'Demo Finance' }),
  name: z.string().trim().min(1).max(80).openapi({ example: 'Asha Verma' }),
  email: EmailSchema,
  password: PasswordInputSchema,
  phone: PhoneE164Schema.optional(),
  timezone: TimezoneSchema.optional(),
});

export const VerifyEmailBody = z.strictObject({
  email: EmailSchema,
  code: z
    .string()
    .regex(/^\d{6}$/, 'Must be the 6-digit code')
    .openapi({ example: '042917' }),
});

export const EmailOnlyBody = z.strictObject({ email: EmailSchema });

export const AcceptedSchema = registry.register(
  'Accepted',
  z.object({
    message: z.string().openapi({ example: 'Check your email for a verification code.' }),
  }),
);

export const PublicUserSchema = registry.register(
  'PublicUser',
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    status: z.enum(['invited', 'active', 'disabled']),
    emailVerifiedAt: z.string().nullable(),
    lastLoginAt: z.string().nullable(),
    platformRole: z.enum(['superadmin']).nullable(),
    createdAt: z.string(),
  }),
);

export const CallingWindowSchema = z.object({
  start: z.string().openapi({ example: '09:00' }),
  end: z.string().openapi({ example: '19:00' }),
  days: z.array(z.number().int().min(0).max(6)).openapi({ example: [1, 2, 3, 4, 5, 6] }),
});

export const PublicAccountSchema = registry.register(
  'PublicAccount',
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['active', 'suspended']),
    suspendReason: z.string().nullable(),
    ownerId: z.string().nullable(),
    isPlatform: z.boolean(),
    timezone: z.string(),
    country: z.string(),
    defaultLanguage: z.enum(['hi', 'en', 'hinglish']),
    settings: z.object({
      callingWindow: CallingWindowSchema,
      recordingEnabled: z.boolean(),
      aiDisclosureEnabled: z.boolean(),
    }),
    createdAt: z.string(),
  }),
);

const sessionBody = {
  user: PublicUserSchema,
  account: PublicAccountSchema,
  role: z.object({ key: z.string(), name: z.string() }),
  permissions: z.array(z.string()),
  impersonation: z.object({ impersonatorId: z.string(), expiresAt: z.string() }).nullable(),
};

export const AuthMeSchema = registry.register('AuthMe', z.object(sessionBody));

export const AuthSessionSchema = registry.register(
  'AuthSession',
  z.object({
    accessToken: z.string(),
    expiresIn: z.number().int().openapi({ example: 900 }),
    ...sessionBody,
  }),
);

const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

const accepted = {
  description: 'Accepted',
  content: { 'application/json': { schema: AcceptedSchema } },
};
const sessionCookie =
  'Signed in. Sets the httpOnly `cav_rt` refresh cookie (Path=/api/v1/auth, SameSite=Strict).';

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/signup',
  tags: ['Auth'],
  summary: 'Create an account + owner; sends a 6-digit email code (always 202)',
  request: json(SignupBody),
  responses: { 202: accepted, 422: errors[422], 429: errors[429] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/verify-email',
  tags: ['Auth'],
  summary: 'Confirm the email code and sign in',
  request: json(VerifyEmailBody),
  responses: { 200: ok(AuthSessionSchema, sessionCookie), 422: errors[422], 429: errors[429] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/verify-email/resend',
  tags: ['Auth'],
  summary: 'Send a new email code (always 202; 60 s cooldown, 5 per hour)',
  request: json(EmailOnlyBody),
  responses: { 202: accepted, 422: errors[422], 429: errors[429] },
});
