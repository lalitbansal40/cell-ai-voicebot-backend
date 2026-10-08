import { getAppInfo } from './shared/app-info';

export { getAppInfo, type AppInfo } from './shared/app-info';

if (require.main === module) {
  // eslint-disable-next-line no-console -- logger + server bootstrap land in T1.4
  console.info('[cell-ai-voicebot-backend]', getAppInfo());
}
