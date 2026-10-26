/** Staging monitor mail: fixed issue names, no server logs or credentials in messages. */
import { getEnv } from '../config/env';
import { createEmailProvider } from '../core/email';
import { getLogger } from '../shared/logger';

import { runOp, say, type OpMain } from './cli';

const ISSUES = [
  'ready',
  'disk',
  'memory',
  'backup-age',
  'backup-failed',
  'certificate',
  'container-restarts',
  'test-alert',
];

export const main: OpMain = async ([to, issue]) => {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !ISSUES.includes(issue ?? ''))
    throw new Error('Usage: alert <recipient> <known issue>');
  const provider = createEmailProvider(getEnv(), getLogger());
  try {
    await provider.send({
      to,
      subject: `Cell AI staging: ${issue ?? ''}`,
      text: `Staging needs attention (${issue ?? ''}). Run status.sh and follow docs/ops/staging.md.`,
      html: `<p>Staging needs attention (${issue ?? ''}). Run status.sh and follow the staging runbook.</p>`,
    });
    say('Staging alert sent');
  } finally {
    await provider.close();
  }
};

if (require.main === module) runOp(main);
