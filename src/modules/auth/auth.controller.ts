import type { Request, Response } from 'express';
import type { z } from 'zod';

import { noContent, ok } from '../../shared/http/envelope';

import { MIN_ENUMERATION_SAFE_MS } from './auth.constants';
import type {
  EmailOnlyBody,
  LoginBody,
  SessionIdParams,
  SignupBody,
  VerifyEmailBody,
} from './auth.schema';
import { resendVerification, signup, verifyEmail, withMinDuration } from './auth.service';
import { login, logout, logoutAll, me, refresh, revokeSession, sessions } from './login.service';

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

export const loginHandler = async ({
  body,
  req,
  res,
}: {
  body: z.infer<typeof LoginBody>;
  req: Request;
  res: Response;
}) => {
  ok(res, await login(req, res, body));
};

export const refreshHandler = async (req: Request, res: Response) => {
  ok(res, await refresh(req, res));
};

export const logoutHandler = async (req: Request, res: Response) => {
  await logout(req, res);
  noContent(res);
};

export const logoutAllHandler = async (req: Request, res: Response) => {
  await logoutAll(req, res);
  noContent(res);
};

export const meHandler = async (req: Request, res: Response) => {
  ok(res, await me(req));
};

export const sessionsHandler = async (req: Request, res: Response) => {
  ok(res, await sessions(req));
};

export const revokeSessionHandler = async ({
  params,
  req,
  res,
}: {
  params: z.infer<typeof SessionIdParams>;
  req: Request;
  res: Response;
}) => {
  await revokeSession(req, res, params.id);
  noContent(res);
};
