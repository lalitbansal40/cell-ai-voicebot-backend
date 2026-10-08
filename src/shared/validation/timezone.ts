let zones: Set<string> | undefined;

/** IANA timezone check (`Intl.supportedValuesOf`) — ADR 0017. `UTC` is always accepted. */
export const isTimezone = (value: string): boolean => {
  zones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);
  return zones.has(value);
};
