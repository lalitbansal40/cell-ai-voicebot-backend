/**
 * DEV ONLY — sends the `system.test` email directly (no queue) with the env
 * provider. Local SMTP = Mailpit (http://localhost:8025).
 * Usage: npm run email:test -- you@example.com
 */
import { getEnv } from '../src/config/env';
import { createEmailProvider, createEmailService } from '../src/core/email';
import { getLogger } from '../src/shared/logger';
import { maskEmail } from '../src/shared/utils/mask';

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('email:test is disabled in production');
  const to = process.argv[2];
  if (!to) throw new Error('Usage: npm run email:test -- you@example.com');
  const logger = getLogger();
  const provider = createEmailProvider(env, logger);
  try {
    const { messageId } = await createEmailService({ provider, logger }).sendTemplate(
      'system.test',
      to,
      { name: 'there' },
    );
    console.info(`driver: ${provider.driver}  to: ${maskEmail(to)}  messageId: ${messageId}`);
  } finally {
    await provider.close();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
