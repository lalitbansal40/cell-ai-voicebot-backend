/** Escapes user text for use inside a RegExp / `$regex`. */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
