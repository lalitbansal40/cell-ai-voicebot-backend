import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOp } from '../../src/ops/cli';
import { recipientOf } from '../../src/ops/email-test';
import { AppError } from '../../src/shared/errors/app-error';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ops CLI (Phase 13 — commands the image runs with node)', () => {
  it('runOp: a failure prints only its message (app error details too) and exits 1', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runOp(() => Promise.reject(new Error('boom')), []);
    runOp(
      () =>
        Promise.reject(new AppError('VALIDATION_FAILED', 'Bad.', [{ path: 'x', message: 'why' }])),
      [],
    );
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    runOp(() => Promise.reject('plain'), []);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(3));
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual(['boom\n', 'Bad. why\n', 'plain\n']);
  });

  it('runOp passes the arguments and stays quiet on success', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const seen: string[][] = [];
    runOp(
      (args) => {
        seen.push(args);
        return Promise.resolve();
      },
      ['up'],
    );
    await vi.waitFor(() => expect(seen).toEqual([['up']]));
    expect(exit).not.toHaveBeenCalled();
  });

  it('email:test needs an address, and --production on a production server', () => {
    expect(recipientOf('development', ['a@b.example'])).toBe('a@b.example');
    expect(recipientOf('production', ['a@b.example', '--production'])).toBe('a@b.example');
    expect(() => recipientOf('production', ['a@b.example'])).toThrow('needs --production');
    expect(() => recipientOf('development', [])).toThrow('Usage');
  });
});
