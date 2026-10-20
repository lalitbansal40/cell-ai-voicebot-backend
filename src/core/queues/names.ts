/** BullMQ queue names. */
export const QUEUES = {
  system: 'system',
  email: 'email',
  maintenance: 'maintenance',
  contacts: 'contacts',
  billing: 'billing',
  ai: 'ai',
  campaigns: 'campaigns',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
