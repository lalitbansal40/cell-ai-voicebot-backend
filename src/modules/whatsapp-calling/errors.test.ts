import { describe, expect, it } from 'vitest';

import { graphError } from '../../core/meta';
import { AppError } from '../../shared/errors/app-error';

import { callError, metaCallErrorOf } from './errors';

describe('Meta calling error mapping', () => {
  it('preserves Meta detail for mapped calling codes, even without an app hint', () => {
    const err = graphError(400, {
      error: { code: 138000, message: 'Calling is disabled', fbtrace_id: 'TRACE-WCF' },
    });
    const mapped = callError(err, undefined, 'calls.connect');
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({ code: 'WHATSAPP_CALLING_DISABLED' });
    expect((mapped as AppError).details?.[0]).toMatchObject({
      message: 'Calling is disabled',
      metaCode: 138000,
      fbtraceId: 'TRACE-WCF',
      op: 'calls.connect',
    });
    expect(metaCallErrorOf(mapped, 'calls.connect')).toMatchObject({
      metaCode: 138000,
      message: 'Calling is disabled',
      fbtraceId: 'TRACE-WCF',
    });
  });
});
