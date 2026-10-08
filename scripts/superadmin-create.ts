/**
 * Creates or updates a platform superadmin (there is NO HTTP route for this).
 * Usage:
 *   npm run superadmin:create -- admin@example.com "Admin Name"            (prompts for the password)
 *   echo "$PW" | npm run superadmin:create -- admin@example.com --password-stdin
 * The password is never printed.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { getEnv } from '../src/config/env';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { getPlatformAccount, upsertActiveUser } from '../src/modules/auth/user-setup';
import { isAppError } from '../src/shared/errors/app-error';
import { getLogger } from '../src/shared/logger';

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

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const fromStdin = args.includes('--password-stdin');
  const [email, ...nameParts] = args.filter((a) => !a.startsWith('--'));
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Usage: npm run superadmin:create -- <email> [name] [--password-stdin]');
  }
  const name = nameParts.join(' ') || 'Platform Admin';
  let password: string;
  if (fromStdin) password = await readStdin();
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
    console.info(`${created ? 'Created' : 'Updated'} superadmin ${email.toLowerCase()}`);
  } finally {
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  const message = isAppError(err)
    ? `${err.message} ${(err.details ?? []).map((d) => d.message).join(' ')}`
    : err instanceof Error
      ? err.message
      : String(err);
  console.error(message);
  process.exit(1);
});
