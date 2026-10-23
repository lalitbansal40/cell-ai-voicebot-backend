import type { StorageProvider } from '../../core/storage';
import type { WhatsAppContext } from '../whatsapp/context';

import type { TemplateJobs } from './jobs';

/** What template management needs: the WhatsApp context (Meta, Redis, key), jobs, storage (header examples). */
export interface TemplateContext {
  wa: WhatsAppContext;
  jobs: TemplateJobs;
  storage?: StorageProvider;
}

export const templateNow = (tx: Pick<TemplateContext, 'wa'>): Date => tx.wa.now?.() ?? new Date();
