/**
 * Error code catalogue — single source of truth in code.
 * MUST match docs/conventions/error-codes.md (enforced by error-codes.test.ts).
 * `message` is the default, user-safe text; callers may pass a more specific one.
 */
export const ERROR_CODES = {
  REQUEST_MALFORMED: { status: 400, message: 'The request could not be parsed.' },
  VALIDATION_FAILED: { status: 422, message: 'Some fields are invalid.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The request is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Unsupported content or file type.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Please try again later.' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    message: 'This Idempotency-Key was already used with a different request.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    message: 'A request with this Idempotency-Key is still being processed.',
  },
  RESOURCE_NOT_FOUND: { status: 404, message: 'Resource not found.' },
  CONFLICT_DUPLICATE: { status: 409, message: 'This resource already exists.' },
  CONFLICT_INVALID_STATE: {
    status: 409,
    message: 'This action is not allowed in the current state.',
  },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong. Please try again.' },
  AUTH_UNAUTHENTICATED: { status: 401, message: 'Authentication required.' },
  AUTH_TOKEN_EXPIRED: { status: 401, message: 'Your session has expired. Please sign in again.' },
  AUTH_INVALID_CREDENTIALS: { status: 401, message: 'Invalid email or password.' },
  AUTH_FORBIDDEN: { status: 403, message: 'You do not have permission to do this.' },
  AUTH_EMAIL_NOT_VERIFIED: { status: 403, message: 'Please verify your email address first.' },
  AUTH_ACCOUNT_SUSPENDED: {
    status: 403,
    message: 'This account is suspended. Changes are not allowed.',
  },
  AUTH_USER_DISABLED: { status: 403, message: 'Your access to this account has been disabled.' },
  AUTH_SESSION_REVOKED: { status: 401, message: 'Your session has ended. Please sign in again.' },
  AUTH_CODE_INVALID: { status: 422, message: 'The code or link is invalid or has expired.' },
  AUTH_TOO_MANY_ATTEMPTS: { status: 429, message: 'Too many attempts. Please try again later.' },
  AUTH_IMPERSONATION_BLOCKED: {
    status: 403,
    message: 'This action is not allowed while viewing as another user.',
  },
  IMPORT_FILE_INVALID: {
    status: 422,
    message: 'The file could not be read as a contact sheet.',
  },
  CONTACT_DND: { status: 422, message: 'This contact is on the do-not-call list.' },
  CONTACT_OPTED_OUT: { status: 422, message: 'This contact has opted out of calls.' },
  WALLET_INSUFFICIENT_BALANCE: { status: 422, message: 'Insufficient wallet balance.' },
  WALLET_BUDGET_EXCEEDED: { status: 422, message: 'Monthly spend budget reached.' },
  BILLING_PROFILE_REQUIRED: {
    status: 422,
    message: 'Add your billing details before adding money.',
  },
  PAYMENT_VERIFICATION_FAILED: {
    status: 422,
    message: 'The payment could not be verified.',
  },
  AI_UNAVAILABLE: { status: 503, message: 'The voice AI service is unavailable.' },
  FLOW_INVALID: { status: 422, message: 'The call flow is invalid.' },
  CALL_OUTSIDE_WINDOW: { status: 422, message: 'Calls are not allowed at this time.' },
  CAMPAIGN_NOT_RUNNABLE: { status: 409, message: 'This campaign cannot be started.' },
  PROVIDER_UNAVAILABLE: { status: 503, message: 'An external provider is unavailable.' },
  PROVIDER_ERROR: { status: 502, message: 'An external provider returned an error.' },
  AI_SPEND_CAP_REACHED: { status: 422, message: 'This agent reached its spending limit.' },
  AGENT_INACTIVE: { status: 409, message: 'This agent is turned off.' },
  FUNCTION_URL_BLOCKED: { status: 422, message: 'This address is not allowed.' },
  KNOWLEDGE_LIMIT_REACHED: { status: 422, message: 'The knowledge base limit is reached.' },
  FLOW_REVISION_CONFLICT: {
    status: 409,
    message: 'This flow was changed by someone else. Reload to continue.',
  },
  RESOURCE_IN_USE: { status: 409, message: 'This item is in use.' },
  CALL_LIMIT_REACHED: { status: 429, message: 'Too many calls are running for this account.' },
  CALL_CAPACITY: {
    status: 503,
    message: 'The server is at its call limit. Try again in a moment.',
  },
  CALL_NOT_ACTIVE: { status: 409, message: 'This call is not running.' },
  CALL_NOT_ALLOWED: { status: 422, message: "This contact can't be called right now." },
  CAMPAIGN_LIMIT_REACHED: {
    status: 429,
    message: 'Too many active campaigns for this account.',
  },
  CAMPAIGN_REVISION_CONFLICT: {
    status: 409,
    message: 'This campaign was changed by someone else. Reload to see the latest version.',
  },
  WHATSAPP_NOT_CONFIGURED: { status: 503, message: "WhatsApp isn't set up on this server." },
  WHATSAPP_SIGNUP_FAILED: { status: 422, message: 'Connecting the WhatsApp number failed.' },
  WHATSAPP_NUMBER_IN_USE: {
    status: 409,
    message: 'This WhatsApp number is already connected to another account.',
  },
  WHATSAPP_CHANNEL_LIMIT: {
    status: 409,
    message: 'This account already has the maximum number of WhatsApp numbers.',
  },
  WHATSAPP_CHANNEL_NOT_READY: {
    status: 409,
    message: 'This WhatsApp number is not ready (finish its setup or reconnect it).',
  },
  META_API_ERROR: { status: 502, message: 'Meta returned an error.' },
  META_SIGNATURE_INVALID: { status: 401, message: 'Invalid Meta signature.' },
  WHATSAPP_WINDOW_CLOSED: {
    status: 409,
    message:
      'The 24-hour window is closed. You can reply when the customer writes again, or send a template.',
  },
  WHATSAPP_RECIPIENT_BLOCKED: { status: 409, message: 'You blocked this customer on WhatsApp.' },
  WHATSAPP_MEDIA_INVALID: { status: 422, message: "This file can't be sent on WhatsApp." },
  WHATSAPP_MEDIA_TOO_LARGE: { status: 413, message: 'This file is too large for WhatsApp.' },
  INBOX_MEDIA_EXPIRED: {
    status: 410,
    message: 'This media is no longer available from WhatsApp (older than 7 days).',
  },
  TEMPLATE_NOT_FOUND: { status: 404, message: 'Template not found.' },
  TEMPLATE_NOT_APPROVED: { status: 409, message: 'This template is not approved by WhatsApp.' },
  TEMPLATE_PAUSED: {
    status: 409,
    message: 'WhatsApp paused this template for low quality. Try again later.',
  },
  TEMPLATE_VARIABLES_MISSING: { status: 422, message: 'Some template variables have no value.' },
  TEMPLATE_PARAMS_INVALID: {
    status: 422,
    message: "The template values don't match the template.",
  },
  TEMPLATE_EDIT_NOT_ALLOWED: { status: 409, message: "This template can't be edited now." },
  TEMPLATE_NAME_TAKEN: {
    status: 409,
    message: 'A template with this name and language already exists (or was deleted recently).',
  },
  TEMPLATE_LIMIT_REACHED: { status: 409, message: 'The WhatsApp template limit is reached.' },
  TEMPLATE_MARKETING_BLOCKED: {
    status: 409,
    message: "Marketing templates can't be sent to this customer.",
  },
  WHATSAPP_FREQUENCY_LIMIT: {
    status: 429,
    message: 'This customer already got a marketing template recently. Try again later.',
  },
  // Phase 12 — WhatsApp calling
  WHATSAPP_CALLING_DISABLED: {
    status: 409,
    message: 'Calling is turned off for this WhatsApp number.',
  },
  WHATSAPP_CALLING_UNAVAILABLE: {
    status: 409,
    message: "WhatsApp calling isn't available for this number.",
  },
  WHATSAPP_CALLING_RESTRICTED: {
    status: 409,
    message: 'WhatsApp has paused calling on this number for now.',
  },
  WHATSAPP_CALL_PERMISSION_MISSING: {
    status: 409,
    message: "This customer hasn't allowed calls from this number yet.",
  },
  WHATSAPP_CALL_PERMISSION_CHECK_FAILED: {
    status: 502,
    message: "Couldn't check the customer's call permission with WhatsApp. Try again.",
  },
  WHATSAPP_CALL_PERMISSION_LIMIT: {
    status: 429,
    message: 'You can ask this customer for call permission again later.',
  },
  WHATSAPP_CALL_PERMISSION_EXISTS: {
    status: 409,
    message: 'This customer already allows calls.',
  },
  WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING: {
    status: 409,
    message: 'Create and get the call permission template approved first.',
  },
  WHATSAPP_CALL_LIMIT_REACHED: {
    status: 429,
    message: "WhatsApp's call limit for this customer is reached. Try again later.",
  },
  WHATSAPP_CALL_ACTIVE: {
    status: 409,
    message: 'A call with this customer is already in progress.',
  },
  WHATSAPP_CALL_TAKEN: { status: 409, message: 'Someone else already answered this call.' },
  WHATSAPP_CALL_NOT_RINGING: { status: 409, message: "This call isn't ringing any more." },
  WHATSAPP_CALL_FAILED: { status: 502, message: "WhatsApp couldn't connect the call." },
  CALL_AGENT_UNAVAILABLE: {
    status: 409,
    message: 'No team member is available to take the call.',
  },
  // Phase 14 — records, transcripts & analytics
  INSIGHTS_NOT_AVAILABLE: {
    status: 409,
    message: 'This call has no transcript to review (not answered or too short).',
  },
  INSIGHTS_DISABLED: {
    status: 409,
    message: 'Post-call AI is turned off in Settings.',
  },
  DISPOSITION_UNKNOWN: {
    status: 422,
    message: 'Choose one of the call outcomes set up in Settings.',
  },
  REPORT_RANGE_INVALID: {
    status: 422,
    message: 'Choose a date range of at most 366 days, with the start before the end.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
