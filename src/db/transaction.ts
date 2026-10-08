import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` in a multi-document transaction (replica set required — ADR 0004).
 * The driver retries transient errors; keep `fn` free of external I/O.
 */
export const withTransaction = async <T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
};
