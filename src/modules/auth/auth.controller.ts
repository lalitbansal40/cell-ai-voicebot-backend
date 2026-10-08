import type { Request, Response } from 'express';
import type { z } from 'zod';

import { ok } from '../../shared/http/envelope';

import { MIN_ENUMERATION_SAFE_MS } from './auth.constants';
import type { EmailOnlyBody, SignupBody, VerifyEmailBody } from './auth.schema';
import { resendVerification, signup, verifyEmail, withMinDuration } from './auth.service';

const accepted = (res: Response, message: string) =>
  res.status(202).json({ success: true, data: { message } });

export const signupHandler = async ({
  body,
  res,
}: {
  body: z.infer<typeof SignupBody>;
  res: Response;
}) => {
  await withMinDuration(MIN_ENUMERATION_SAFE_MS, () => signup(body));
  accepted(res, 'Check your email for a verification code.');
};

export const verifyEmailHandler = async ({
  body,
  req,
  res,
}: {
  body: z.infer<typeof VerifyEmailBody>;
  req: Request;
  res: Response;
}) => {
  ok(res, await verifyEmail(req, res, body));
};

export const resendHandler = async ({
  body,
  res,
}: {
  body: z.infer<typeof EmailOnlyBody>;
  res: Response;
}) => {
  await withMinDuration(MIN_ENUMERATION_SAFE_MS, () => resendVerification(body.email));
  accepted(res, 'If the email needs verification, a new code is on its way.');
};
