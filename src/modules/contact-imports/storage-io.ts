import type { StorageProvider } from '../../core/storage';

/** Whole stored file as a Buffer (imports are ≤ 10 MB). */
export const readStoredFile = async (storage: StorageProvider, key: string): Promise<Buffer> => {
  const stream = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
};

/** Deletes a stored file; a missing file is fine (purges and cancels are idempotent). */
export const deleteQuietly = async (
  storage: StorageProvider,
  key?: string | null,
): Promise<void> => {
  if (!key) return;
  try {
    await storage.delete(key);
  } catch {
    // already gone
  }
};
