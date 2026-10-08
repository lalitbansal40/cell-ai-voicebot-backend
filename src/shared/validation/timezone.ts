/** `Area/Location` (or `UTC`) — rejects raw offsets like `+05:30`, which Intl also accepts. */
const ZONE_NAME = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * IANA timezone check — ADR 0017. Any name `Intl.DateTimeFormat` resolves is
 * valid, including current names that ICU only knows as aliases
 * (`Asia/Kolkata`; `Intl.supportedValuesOf` lists `Asia/Calcutta`).
 */
export const isTimezone = (value: string): boolean => {
  if (!ZONE_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
