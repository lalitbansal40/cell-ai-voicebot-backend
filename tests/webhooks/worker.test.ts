import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../../src/core/email/templates';
import {
  processMaintenanceJob,
  WEBHOOK_HEALTH_JOB,
} from '../../src/core/queues/workers/maintenance.worker';
import { processWebhookJob } from '../../src/core/queues/workers/webhooks.worker';
import { webhookRuntime } from '../../src/modules/webhooks/deliver.job';
import { deliverJobId, WEBHOOK_JOBS } from '../../src/modules/webhooks/jobs';
import { createLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { testEnv } from '../helpers/test-app';

useTestDb();
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

describe('webhooks worker', () => {
  it('runs deliveries by name and refuses unknown jobs', async () => {
    const run = processWebhookJob(webhookRuntime(testEnv()));
    await expect(
      run({
        name: WEBHOOK_JOBS.deliver,
        data: { deliveryId: '6720f0a1b2c3d4e5f6a7b8c9', attempt: 1 },
      } as never),
    ).resolves.toEqual({ status: 'missing' });
    await expect(run({ name: 'nope', data: {} } as never)).rejects.toThrow('Unknown webhook job');
    expect(deliverJobId('abc', 3)).toBe('wh-abc-3');
    expect(deliverJobId('abc', 3)).not.toContain(':');
  });

  it('webhook-health runs on the maintenance queue', async () => {
    await expect(
      processMaintenanceJob({ logger })({ name: WEBHOOK_HEALTH_JOB } as never),
    ).resolves.toEqual({ disabled: expect.any(Number) as number });
  });

  it('renders the "webhook turned off" e-mail with the host only', () => {
    const mail = renderTemplate('webhooks.endpoint_disabled', {
      accountName: 'NotifyNow Demo',
      host: 'crm.example.com',
      description: 'CRM <sync>',
      webhooksUrl: 'https://wa.notifynow.in/integrations/webhooks',
    });
    expect(mail.subject).toBe('NotifyNow Demo: a webhook was turned off');
    expect(mail.html).toContain('CRM &lt;sync&gt;');
    expect(mail.text).toContain('https://wa.notifynow.in/integrations/webhooks');
    const bare = renderTemplate('webhooks.endpoint_disabled', {
      accountName: 'A',
      host: 'h.example.com',
      description: '',
      webhooksUrl: 'https://x',
    });
    expect(bare.text).toContain('Deliveries to h.example.com kept failing');
  });
});
