// Minimal typings for the parts of `smtp-server` used in tests. The package
// ships no types, and @types/smtp-server pulls in @types/nodemailer, which
// would clash with nodemailer 10's bundled types.
declare module 'smtp-server' {
  import type { Server } from 'node:net';
  import type { Readable } from 'node:stream';

  interface SMTPError extends Error {
    responseCode?: number;
  }

  interface SMTPAddress {
    address: string;
  }

  interface SMTPSession {
    envelope: { mailFrom: SMTPAddress | false; rcptTo: SMTPAddress[] };
  }

  interface SMTPAuth {
    username?: string;
    password?: string;
  }

  interface SMTPServerOptions {
    secure?: boolean;
    authOptional?: boolean;
    allowInsecureAuth?: boolean;
    disabledCommands?: string[];
    logger?: boolean;
    onAuth?: (
      auth: SMTPAuth,
      session: SMTPSession,
      callback: (err: Error | null, response?: { user: string }) => void,
    ) => void;
    onRcptTo?: (
      address: SMTPAddress,
      session: SMTPSession,
      callback: (err?: SMTPError | null) => void,
    ) => void;
    onData?: (
      stream: Readable,
      session: SMTPSession,
      callback: (err?: Error | null) => void,
    ) => void;
  }

  export class SMTPServer {
    constructor(options?: SMTPServerOptions);
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
    server: Server;
  }
}
