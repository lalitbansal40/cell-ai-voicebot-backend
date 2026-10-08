export interface AppInfo {
  name: string;
  version: string;
  node: string;
  env: string;
}

/**
 * Basic app metadata. Version comes from npm's env (set when run via npm scripts)
 * instead of importing package.json, which sits outside `rootDir`.
 */
export const getAppInfo = (): AppInfo => ({
  name: 'cell-ai-voicebot-backend',
  version: process.env.npm_package_version ?? '0.0.0-dev',
  node: process.version,
  env: process.env.NODE_ENV ?? 'development',
});
