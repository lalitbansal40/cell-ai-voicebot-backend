import type { Request, Response } from 'express';

import { getAppInfo } from '../../shared/app-info';
import { ok } from '../../shared/http/envelope';

/** GET /api/v1/system/info — service name, version and runtime (AppInfoSchema). */
export const getSystemInfo = (_req: Request, res: Response): void => {
  ok(res, getAppInfo());
};
