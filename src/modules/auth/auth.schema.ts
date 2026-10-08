import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
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

export const LoginBody = z.strictObject({ email: EmailSchema, password: PasswordInputSchema });

export const ResetPasswordBody = z.strictObject({
  token: z.string().min(20).max(100),
  password: PasswordInputSchema,
});

export const ChangePasswordBody = z.strictObject({
  currentPassword: PasswordInputSchema,
  newPassword: PasswordInputSchema,
});

export const SessionIdParams = z.strictObject({ id: z.string().min(8).max(64) });

export const SessionSchema = registry.register(
  'Session',
  z.object({
    id: z.string().openapi({ description: 'Session (refresh family) id' }),
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    current: z.boolean(),
  }),
);

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
  path: '/api/v1/auth/login',
  tags: ['Auth'],
  summary: 'Sign in with email + password (5 failures in 15 min → 429)',
  request: json(LoginBody),
  responses: {
    200: ok(AuthSessionSchema, sessionCookie),
    401: errors[401],
    403: errors[403],
    422: errors[422],
    429: errors[429],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/refresh',
  tags: ['Auth'],
  summary:
    'New access token from the refresh cookie (rotates the cookie; reuse revokes the session)',
  responses: { 200: ok(AuthSessionSchema, sessionCookie), 401: errors[401], 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/logout',
  tags: ['Auth'],
  summary: 'End the cookie session (idempotent, clears the cookie)',
  responses: { 204: noContentResponse },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/logout-all',
  tags: ['Auth'],
  summary: 'Sign out of every session (all access tokens stop working)',
  security: bearer,
  responses: { 204: noContentResponse, 401: errors[401], 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/me',
  tags: ['Auth'],
  summary: 'Current user, account, role, permissions and impersonation info',
  security: bearer,
  responses: { 200: ok(AuthMeSchema), 401: errors[401] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/sessions',
  tags: ['Auth'],
  summary: 'Active sessions of the current user',
  security: bearer,
  responses: { 200: ok(z.array(SessionSchema)), 401: errors[401] },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/auth/sessions/{id}',
  tags: ['Auth'],
  summary: 'Revoke one of your sessions',
  security: bearer,
  request: { params: SessionIdParams },
  responses: { 204: noContentResponse, 401: errors[401], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/verify-email/resend',
  tags: ['Auth'],
  summary: 'Send a new email code (always 202; 60 s cooldown, 5 per hour)',
  request: json(EmailOnlyBody),
  responses: { 202: accepted, 422: errors[422], 429: errors[429] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/forgot-password',
  tags: ['Auth'],
  summary: 'Email a password reset link (always 202)',
  request: json(EmailOnlyBody),
  responses: { 202: accepted, 422: errors[422], 429: errors[429] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/reset-password',
  tags: ['Auth'],
  summary: 'Set a new password from a reset link (ends every session)',
  request: json(ResetPasswordBody),
  responses: {
    200: {
      description: 'Password changed',
      content: { 'application/json': { schema: AcceptedSchema } },
    },
    422: errors[422],
    429: errors[429],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/change-password',
  tags: ['Auth'],
  summary: 'Change your password (other sessions end; returns new tokens for this one)',
  security: bearer,
  request: json(ChangePasswordBody),
  responses: { 200: ok(AuthSessionSchema), 401: errors[401], 403: errors[403], 422: errors[422] },
});
