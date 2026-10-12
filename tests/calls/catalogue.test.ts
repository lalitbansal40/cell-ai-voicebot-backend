import { describe, expect, it } from 'vitest';

import { CALL_LIMITS, CALL_LINES } from '../../src/config/limits';
import { WS_EVENT_TYPES } from '../../src/core/realtime/events';
import { DEFAULT_ACCOUNT_SETTINGS } from '../../src/db/models/account.model';
import { LEDGER_USAGE_KINDS } from '../../src/db/models/ledger-entry.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import { AppError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';

describe('Phase 7 catalogue', () => {
  it('has 44 error codes incl. the three call codes', () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(44);
    expect(ERROR_CODES.CALL_LIMIT_REACHED.status).toBe(429);
    expect(ERROR_CODES.CALL_CAPACITY.status).toBe(503);
    expect(ERROR_CODES.CALL_NOT_ACTIVE.status).toBe(409);
    expect(new AppError('CALL_NOT_ACTIVE')).toMatchObject({
      status: 409,
      message: 'This call is not running.',
    });
  });

  it('has 71 audit actions incl. the three call actions', () => {
    expect(AUDIT_ACTIONS).toHaveLength(71);
    expect(AUDIT_ACTIONS.filter((a) => a.startsWith('call.'))).toEqual([
      'call.test_started',
      'call.recording_accessed',
      'call.hung_up_remotely',
    ]);
  });

  it('lists the call WS events and bills calls with the call ledger kind', () => {
    expect(WS_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'call.created',
        'call.status',
        'call.transcript',
        'call.dtmf',
        'call.ended',
      ]),
    );
    expect(LEDGER_USAGE_KINDS).toContain('call');
  });

  it('call permissions per role are unchanged (read for all, trigger / listen not for viewers)', () => {
    const callsOf = (key: keyof typeof SYSTEM_ROLES) =>
      SYSTEM_ROLES[key].permissions.filter((p) => p.startsWith('calls.')).sort();
    expect(callsOf('manager')).toEqual([
      'calls.export',
      'calls.listen',
      'calls.read',
      'calls.trigger',
    ]);
    expect(callsOf('agent')).toEqual(['calls.listen', 'calls.read', 'calls.trigger']);
    expect(callsOf('viewer')).toEqual(['calls.read']);
  });

  it('web audio frames are 20 ms of PCM16 at 24 kHz; locked lines and notice default', () => {
    expect(CALL_LIMITS.webFrameBytes).toBe(
      (CALL_LIMITS.webSampleRate * CALL_LIMITS.frameMs * 2) / 1000,
    );
    expect(DEFAULT_ACCOUNT_SETTINGS.recordingNotice).toBe(CALL_LINES.recordingNotice);
    expect(CALL_LINES.recordingNotice.length).toBeLessThanOrEqual(
      CALL_LIMITS.recordingNoticeMaxChars,
    );
  });
});
