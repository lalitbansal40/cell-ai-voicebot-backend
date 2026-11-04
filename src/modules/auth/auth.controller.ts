import type { Request, Response } from 'express';
import type { z } from 'zod';

import { AppError } from '../../shared/errors/app-error';
import { created, noContent, ok } from '../../shared/http/envelope';

import { MIN_ENUMERATION_SAFE_MS } from './auth.constants';
import type {
  ChangePasswordBody,
  EmailOnlyBody,
  LoginBody,
  ResetPasswordBody,
  SessionIdParams,
  SignupBody,
} from './auth.schema';
import { signup, withMinDuration } from './auth.service';
import { login, logout, logoutAll, me, refresh, revokeSession, sessions } from './login.service';
import { changePassword, forgotPassword, resetPassword } from './password.service';

const accepted = (res: Response, message: string) =>
  res.status(202).json({ success: true, data: { message } });

export const signupHandler = async ({
  body,
  req,
  res,
}: {
  body: z.infer<typeof SignupBody>;
  req: Request;
  res: Response;
}) => {
  created(res, await signup(req, res, body));
};

/** Phase 19: the e-mail code routes are gone (old links / apps get a clear answer). */
export const goneHandler = (): never => {
  throw new AppError('AUTH_ROUTE_GONE');
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

export const forgotPasswordHandler = async ({
  body,
  req,
  res,
}: {
  body: z.infer<typeof EmailOnlyBody>;
  req: Request;
  res: Response;
}) => {
  await withMinDuration(MIN_ENUMERATION_SAFE_MS, () => forgotPassword(req, body.email));
  accepted(res, 'If an account exists for this email, we sent a reset link.');
};

export const resetPasswordHandler = async ({
  body,
  req,
  res,
}: {
  body: z.infer<typeof ResetPasswordBody>;
  req: Request;
  res: Response;
}) => {
  await resetPassword(req, body);
  ok(res, { message: 'Your password was changed. Please sign in again.' });
};

export const changePasswordHandler = async ({
  body,
  req,
  res,
}: {
  body: z.infer<typeof ChangePasswordBody>;
  req: Request;
  res: Response;
}) => {
  ok(res, await changePassword(req, res, body));
};
