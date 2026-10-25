import type { CallHours } from '../../db/models/whatsapp-channel.model';

/** Meta's opening hours in the number's timezone. A holiday replaces that day's hours. */
export const withinCallHours = (hours: CallHours, at: Date): boolean => {
  if (!hours.enabled) return true;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: hours.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}${parts.minute}`;
  const holiday = hours.holidays.find((h) => h.date === date);
  if (holiday)
    return Boolean(holiday.start && holiday.end && time >= holiday.start && time < holiday.end);
  const day = (parts.weekday ?? '').toUpperCase();
  return hours.weekly.some((h) => h.day === day && time >= h.open && time < h.close);
};

/** Intersection of the permission, online presence, availability and optional ring list. */
export const selectRingTargets = (input: {
  eligible: readonly string[];
  online: readonly string[];
  available: readonly string[];
  ringUserIds: readonly string[] | null;
}): string[] => {
  const online = new Set(input.online);
  const available = new Set(input.available);
  const selected = input.ringUserIds === null ? null : new Set(input.ringUserIds);
  return [...new Set(input.eligible)].filter(
    (id) => online.has(id) && available.has(id) && (selected === null || selected.has(id)),
  );
};
