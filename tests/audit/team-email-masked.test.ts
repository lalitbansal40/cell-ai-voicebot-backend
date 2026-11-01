import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('audit of team changes', () => {
  it('stores a masked e-mail, as docs/conventions/audit.md says', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'modules', 'team', 'team.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/meta: \{ email: (user|target)\.email \}/);
    expect(source).toMatch(/meta: \{ email: maskEmail\(target\.email\) \}/);
    expect(source).toMatch(/meta: \{ email: maskEmail\(user\.email\) \}/);
  });
});
