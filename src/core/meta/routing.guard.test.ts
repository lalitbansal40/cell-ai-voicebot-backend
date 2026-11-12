import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * PN (D7): every channel-bound Graph call goes through `clientFor(ctx, channel)` so a
 * managed (Pinnacle) number never reaches Meta directly. A direct `….meta.<method>(` call
 * is allowed only on a line marked `// meta-only` (embedded signup, our Meta app).
 */
const CHANNEL_METHODS = [
  'sendMessage',
  'markRead',
  'uploadMedia',
  'getMediaUrl',
  'downloadMedia',
  'uploadExample',
  'createTemplate',
  'editTemplate',
  'deleteTemplate',
  'listTemplates',
  'getWaba',
  'listPhoneNumbers',
  'getPhoneNumber',
  'registerPhone',
  'blockUsers',
  'unblockUsers',
  'getBusinessProfile',
  'updateBusinessProfile',
  'uploadProfilePhoto',
  'getPhoneSettings',
  'updateCallingSettings',
  'getCallPermissions',
  'startCall',
  'preAcceptCall',
  'acceptCall',
  'rejectCall',
  'terminateCall',
  'debugToken',
  'subscribeApp',
  'unsubscribeApp',
  'getAppSubscriptions',
  'listOwnedWabas',
  'listBusinessesWithWabas',
  'exchangeCode',
];
const DIRECT = new RegExp(`(?:\\.|\\b)meta\\.(${CHANNEL_METHODS.join('|')})\\(`);

const ROOT = join(__dirname, '../../modules');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });

describe('Graph calls are routed per channel provider (PN)', () => {
  it('no direct channel-bound `meta.<method>(` outside `// meta-only` lines', () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!DIRECT.test(line)) return;
        const marked = [line, lines[i - 1] ?? '', lines[i - 2] ?? ''].some((l) =>
          l.includes('meta-only'),
        );
        if (!marked) offenders.push(`${relative(ROOT, file)}:${String(i + 1)}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
