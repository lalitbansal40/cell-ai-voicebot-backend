import { isMetaApiError, META_ERROR_CODES, type MetaApiError } from '../../core/meta';
import { AppError } from '../../shared/errors/app-error';

/** Where a signup failed (`details[0].message`). */
export type SignupStep = 'exchange' | 'verify' | 'waba' | 'phone';

export const signupFailed = (step: SignupStep, message: string): AppError =>
  new AppError('WHATSAPP_SIGNUP_FAILED', message, [{ path: 'step', message: step }]);

/** `502 META_API_ERROR` with Meta's code / subcode / trace id (message already scrubbed). */
export const metaApiError = (err: MetaApiError): AppError =>
  new AppError(
    'META_API_ERROR',
    undefined,
    [
      {
        path: 'meta',
        message: err.message,
        ...(err.code !== null ? { metaCode: err.code } : {}),
        ...(err.subcode !== null ? { metaSubcode: err.subcode } : {}),
        ...(err.fbtraceId ? { fbtraceId: err.fbtraceId } : {}),
      },
    ],
    { cause: err },
  );

/** Before a channel exists: Meta errors become signup / API errors (the token is dropped). */
export const signupError = (err: unknown, step: SignupStep): unknown => {
  if (!isMetaApiError(err)) return err;
  if (step === 'exchange' && (err.code === 100 || err.type === 'OAuthException')) {
    return signupFailed(
      'exchange',
      err.subcode === META_ERROR_CODES.codeUsed
        ? 'This Meta signup was already used — connect again.'
        : 'The Meta signup expired — try again.',
    );
  }
  if (err.tokenInvalid) {
    return signupFailed('verify', "Meta didn't confirm access to WhatsApp — try again.");
  }
  return metaApiError(err);
};

export const notReady = (message?: string): AppError =>
  new AppError('WHATSAPP_CHANNEL_NOT_READY', message);
