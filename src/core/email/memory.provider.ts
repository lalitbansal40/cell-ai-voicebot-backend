import type { EmailMessage, EmailProvider, EmailSendResult } from './email.types';

/** Test driver: keeps sent messages in memory. Not selectable via env. */
export class MemoryEmailProvider implements EmailProvider {
  readonly driver = 'memory' as const;
  readonly sent: EmailMessage[] = [];
  /** When set, every `send` fails with this error (tests for retries). */
  failWith?: Error;

  send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve({ messageId: `mem-${this.sent.length}` });
  }

  clear(): void {
    this.sent.length = 0;
  }

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
