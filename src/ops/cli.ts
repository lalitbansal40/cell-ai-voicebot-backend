import { isAppError } from '../shared/errors/app-error';

/**
 * Production ops commands (Phase 13): compiled into `dist/ops/*.js`, so the image runs
 * them with plain `node` (no `tsx`); `scripts/*.ts` call the same `main` in development.
 */
export type OpMain = (args: string[]) => Promise<void>;

/** One line per message on stdout (ops output never holds secrets). */
export const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const messageOf = (err: unknown): string =>
  isAppError(err)
    ? `${err.message} ${(err.details ?? []).map((d) => d.message).join(' ')}`.trim()
    : err instanceof Error
      ? err.message
      : String(err);

/** Runs an op with the process arguments; exit code 1 and the message on failure. */
export const runOp = (main: OpMain, args: string[] = process.argv.slice(2)): void => {
  main(args).catch((err: unknown) => {
    process.stderr.write(`${messageOf(err)}\n`);
    process.exit(1);
  });
};
