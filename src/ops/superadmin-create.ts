/**
 * Creates or updates a platform superadmin (there is NO HTTP route for this).
 * Usage:
 *   npm run superadmin:create -- admin@example.com "Admin Name"            (prompts for the password)
 *   node dist/ops/superadmin-create.js admin@example.com --password-stdin   (in the image)
 *   echo "$PW" | npm run superadmin:create -- admin@example.com --password-stdin
 * The password is never printed.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { getEnv } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/mongo';
import { getPlatformAccount, upsertActiveUser } from '../modules/auth/user-setup';
import { getLogger } from '../shared/logger';
import { maskEmail } from '../shared/utils/mask';

import { runOp, say, type OpMain } from './cli';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
};

const promptHidden = (question: string): Promise<string> =>
  new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });

export const main: OpMain = async (args) => {
  const fromStdin = args.includes('--password-stdin');
  const [givenEmail, ...nameParts] = args.filter((a) => !a.startsWith('--'));
  const email = givenEmail ?? process.env.SUPERADMIN_EMAIL;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Usage: npm run superadmin:create -- <email> [name] [--password-stdin]');
  }
  const name = nameParts.join(' ') || 'Platform Admin';
  let password: string;
  if (fromStdin) password = await readStdin();
  else if (process.env.SUPERADMIN_PASSWORD) password = process.env.SUPERADMIN_PASSWORD;
  else if (process.stdin.isTTY) {
    password = await promptHidden('Password: ');
    if ((await promptHidden('Repeat password: ')) !== password)
      throw new Error('Passwords do not match');
  } else throw new Error('No TTY — pass the password with --password-stdin');

  const env = getEnv();
  await connectMongo(env, getLogger());
  try {
    const platform = await getPlatformAccount();
    const { created } = await upsertActiveUser({
      accountId: platform._id,
      roleKey: 'owner',
      email,
      name,
      password,
      platformRole: 'superadmin',
      updatePassword: true,
    });
    say(`${created ? 'Created' : 'Updated'} superadmin ${maskEmail(email.toLowerCase())}`);
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
