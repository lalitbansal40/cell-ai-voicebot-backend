import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface AppInfo {
  name: string;
  version: string;
  node: string;
  env: string;
}

let cachedVersion: string | undefined;

/**
 * Version from package.json, read at runtime: src/shared and dist/shared are
 * both two levels below the package root (importing the JSON would pull it
 * into `rootDir`). Works under `node dist/…` too, unlike `npm_package_version`.
 */
const readVersion = (): string => {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
  } catch {
    cachedVersion = '0.0.0-dev';
  }
  return cachedVersion;
};

/** Basic app metadata (`GET /api/v1/system/info`, OpenAPI `info.version`). */
export const getAppInfo = (): AppInfo => ({
  name: 'cell-ai-voicebot-backend',
  version: readVersion(),
  node: process.version,
  env: process.env.NODE_ENV ?? 'development',
});
