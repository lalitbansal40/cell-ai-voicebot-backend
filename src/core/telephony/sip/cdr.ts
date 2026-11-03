/**
 * Trunk CDR reconcile (T18.10): the carrier's call records (CSV) against our SIP calls,
 * minutes per day. A report only — no money moves.
 */

export interface CdrDay {
  day: string;
  cdrCalls: number;
  cdrMinutes: number;
  ourCalls: number;
  ourMinutes: number;
  diffMinutes: number;
}

const DATE_COLUMNS = ['date', 'start', 'start_time', 'starttime', 'calldate', 'call_date'];
const SECONDS_COLUMNS = ['billsec', 'bill_sec', 'duration', 'seconds', 'billed_seconds'];

const splitCsv = (line: string): string[] => {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
};

/** Minutes are started minutes (`ceil(seconds / 60)`), as trunks bill. Days are UTC dates. */
export const parseCdr = (csv: string): { day: string; seconds: number }[] => {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = splitCsv(lines[0] ?? '').map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const dateAt = header.findIndex((h) => DATE_COLUMNS.includes(h));
  const secAt = header.findIndex((h) => SECONDS_COLUMNS.includes(h));
  if (dateAt === -1 || secAt === -1) {
    throw new Error(
      `CDR needs a date column (${DATE_COLUMNS.join('/')}) and a seconds column (${SECONDS_COLUMNS.join('/')})`,
    );
  }
  return lines.slice(1).flatMap((line) => {
    const cells = splitCsv(line);
    const at = new Date((cells[dateAt] ?? '').replace(' ', 'T'));
    const seconds = Number(cells[secAt]);
    if (Number.isNaN(at.getTime()) || !Number.isFinite(seconds) || seconds < 0) return [];
    return [{ day: at.toISOString().slice(0, 10), seconds }];
  });
};

export const reconcileCdr = (
  cdr: { day: string; seconds: number }[],
  ours: { day: string; seconds: number }[],
): CdrDay[] => {
  const days = new Map<string, CdrDay>();
  const row = (day: string) => {
    let r = days.get(day);
    if (!r) {
      r = { day, cdrCalls: 0, cdrMinutes: 0, ourCalls: 0, ourMinutes: 0, diffMinutes: 0 };
      days.set(day, r);
    }
    return r;
  };
  for (const c of cdr) {
    if (c.seconds <= 0) continue;
    const r = row(c.day);
    r.cdrCalls += 1;
    r.cdrMinutes += Math.ceil(c.seconds / 60);
  }
  for (const c of ours) {
    if (c.seconds <= 0) continue;
    const r = row(c.day);
    r.ourCalls += 1;
    r.ourMinutes += Math.ceil(c.seconds / 60);
  }
  return [...days.values()]
    .map((r) => ({ ...r, diffMinutes: r.cdrMinutes - r.ourMinutes }))
    .sort((a, b) => a.day.localeCompare(b.day));
};
