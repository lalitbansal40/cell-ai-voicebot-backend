/** Wall-clock parts of `date` in `timeZone`. */
const zonedParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, number>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = Number(p.value);
      return acc;
    }, {});
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
};

/** Offset of `timeZone` from UTC at `date`, in ms (IST → +5:30). */
const offsetMs = (date: Date, timeZone: string): number => {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/** `YYYY-MM-DD` midnight in `timeZone` as a UTC instant. */
export const startOfDayInZone = (ymd: string, timeZone: string): Date => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(new Date(guess), timeZone);
  // second pass for zones whose offset differs at the true instant (DST)
  return new Date(guess - offsetMs(new Date(first), timeZone));
};

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export const ymdInZone = (date: Date, timeZone: string): string => {
  const p = zonedParts(date, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** `YYYY-MM-DD` + n days (calendar arithmetic, no timezone). */
export const addDays = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** `2026-10-09 18:05:00` in `timeZone` (CSV exports). */
export const formatDateTimeInZone = (date: Date, timeZone: string): string => {
  const p = zonedParts(date, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${ymdInZone(date, timeZone)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
};
