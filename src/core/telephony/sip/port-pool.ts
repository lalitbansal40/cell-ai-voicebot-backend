/** Local UDP ports for our side of ExternalMedia (`SIP_APP_RTP_PORTS`), one per call. */
export class PortPool {
  private readonly leases = new Map<number, string>();
  private cursor: number;

  constructor(
    readonly min: number,
    readonly max: number,
    /** First port tried; two processes on one range start apart (bind retries cover clashes). */
    start = min,
  ) {
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 1024 ||
      max > 65535 ||
      min > max
    ) {
      throw new RangeError('port range must be within 1024-65535');
    }
    this.cursor = Math.min(Math.max(start, min), max);
  }

  get size(): number {
    return this.max - this.min + 1;
  }

  get leased(): number {
    return this.leases.size;
  }

  /** The next free port (round robin, so a just-freed port is not reused at once), or null. */
  lease(callId: string, skip: ReadonlySet<number> = new Set()): number | null {
    for (let i = 0; i < this.size; i += 1) {
      const port = this.cursor;
      this.cursor = port >= this.max ? this.min : port + 1;
      if (!this.leases.has(port) && !skip.has(port)) {
        this.leases.set(port, callId);
        return port;
      }
    }
    return null;
  }

  release(port: number): void {
    this.leases.delete(port);
  }

  /** Frees ports whose call is no longer live; returns how many. */
  sweep(isLive: (callId: string) => boolean): number {
    let freed = 0;
    for (const [port, callId] of this.leases) {
      if (!isLive(callId)) {
        this.leases.delete(port);
        freed += 1;
      }
    }
    return freed;
  }
}

/** Parses `21000-21999`. */
export const parsePortRange = (value: string): { min: number; max: number } => {
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(value.trim());
  if (!m) throw new RangeError('expected a port range like 21000-21999');
  return { min: Number(m[1]), max: Number(m[2]) };
};
