import { ValidationError } from '../errors/app-error';

/** Keyset cursor for "newest first" lists: the last item's time + id. */
export interface TimeCursor {
  at: string;
  id: string;
}

export const encodeCursor = (c: TimeCursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

/** Throws a 422 (`query.cursor`) for anything that isn't a cursor we made. */
export const decodeCursor = (raw: string): TimeCursor => {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<TimeCursor>;
    if (typeof c.at !== 'string' || typeof c.id !== 'string' || !/^[a-f0-9]{24}$/.test(c.id))
      throw new Error();
    if (Number.isNaN(Date.parse(c.at))) throw new Error();
    return { at: c.at, id: c.id };
  } catch {
    throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor' }]);
  }
};
