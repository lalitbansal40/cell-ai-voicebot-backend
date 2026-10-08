import type { Realtime } from './ws-server';

export * from './events';
export * from './topics';
export * from './ws-server';
export * from './ws-tickets';

let instance: Realtime | undefined;

/** Set once by the server after listening; later modules push events through it. */
export const setRealtime = (realtime: Realtime | undefined): void => {
  instance = realtime;
};

export const getRealtime = (): Realtime => {
  if (!instance) throw new Error('Realtime is not initialised (server not started)');
  return instance;
};
