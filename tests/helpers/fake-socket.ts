import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SocketLike } from '../../src/core/voice/providers/types';

/** In-memory socket for provider tests: records what was sent, replays server events. */
export class FakeSocket extends EventEmitter implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  /** Server → client message (object or raw text). */
  receive(event: unknown): void {
    this.emit('message', typeof event === 'string' ? event : Buffer.from(JSON.stringify(event)));
  }

  sentTypes(): string[] {
    return this.sent.map((e) => String(e.type));
  }
}

/** Events of `tests/fixtures/realtime/<name>.jsonl`. */
export const realtimeFixture = (name: string): Record<string, unknown>[] =>
  readFileSync(path.join(__dirname, '../fixtures/realtime', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
