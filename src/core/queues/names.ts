/** BullMQ queue names. */
export const QUEUES = {
  system: 'system',
  email: 'email',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
