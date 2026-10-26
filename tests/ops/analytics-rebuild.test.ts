import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { parseRebuildArgs } from '../../src/ops/analytics-rebuild';

describe('analytics:rebuild arguments', () => {
  it('defaults, every option, and rejections', () => {
    expect(parseRebuildArgs([])).toEqual({ accountId: null, from: null, to: null, dryRun: false });
    const id = new Types.ObjectId().toString();
    expect(
      parseRebuildArgs([
        '--account',
        id,
        '--from',
        '2026-10-01',
        '--to',
        '2026-10-27',
        '--dry-run',
      ]),
    ).toEqual({
      accountId: new Types.ObjectId(id),
      from: '2026-10-01',
      to: '2026-10-27',
      dryRun: true,
    });
    for (const bad of [['--account', 'nope'], ['--from', '27-10-2026'], ['--to'], ['--everything']])
      expect(() => parseRebuildArgs(bad)).toThrow('Usage: analytics:rebuild');
    expect(() => parseRebuildArgs(['--from', '2026-10-05', '--to', '2026-10-01'])).toThrow(
      '--from must not be after --to',
    );
  });
});
