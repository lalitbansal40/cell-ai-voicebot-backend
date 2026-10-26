/**
 * Sends the `system.test` email directly (no queue) with the env provider. Local SMTP =
 * Mailpit (http://localhost:8025). Usage: `npm run email:test -- you@example.com`; on a
 * production server (Phase 13 SMTP check) `node dist/ops/email-test.js you@example.com
 * --production` — the flag is required there so it is never sent by accident.
 */
import { getEnv } from '../config/env';
import { createEmailProvider, createEmailService } from '../core/email';
import { getLogger } from '../shared/logger';
import { maskEmail } from '../shared/utils/mask';

import { runOp, say, type OpMain } from './cli';

/** The recipient from the arguments; production needs the explicit `--production` flag. */
export const recipientOf = (nodeEnv: string, args: string[]): string => {
  if (nodeEnv === 'production' && !args.includes('--production'))
    throw new Error('email:test on a production server needs --production');
  const to = args.find((a) => !a.startsWith('--'));
  if (!to) throw new Error('Usage: npm run email:test -- you@example.com');
  return to;
};

export const main: OpMain = async (args) => {
  const env = getEnv();
  const to = recipientOf(env.NODE_ENV, args);
  const logger = getLogger();
  const provider = createEmailProvider(env, logger);
  try {
    const { messageId } = await createEmailService({ provider, logger }).sendTemplate(
      'system.test',
      to,
      { name: 'there' },
    );
    say(`driver: ${provider.driver}  to: ${maskEmail(to)}  messageId: ${messageId}`);
  } finally {
    await provider.close();
  }
};

if (require.main === module) runOp(main);
