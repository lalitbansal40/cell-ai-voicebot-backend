/** BullMQ queue names. */
export const QUEUES = {
  system: 'system',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
