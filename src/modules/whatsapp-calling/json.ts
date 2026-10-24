import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { defaultCalling } from '../../db/models/whatsapp-channel.model';

import { activeRestrictions, bicCountryBlocked } from './availability';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The number's calling settings for the app (never tokens, never Meta payloads). */
export const callingView = (channel: WhatsAppChannelDoc, now = new Date()) => {
  const c = channel.calling ?? defaultCalling();
  const bicRestricted = activeRestrictions(c, 'business', now).length > 0;
  return {
    channelId: channel._id.toString(),
    status: c.status,
    unavailableReason: c.unavailableReason,
    /** Business-initiated calls possible now (status, country, restriction). */
    businessCallsAvailable: c.status === 'enabled' && !bicCountryBlocked(channel) && !bicRestricted,
    businessCallsBlockedBy:
      c.status !== 'enabled'
        ? c.status
        : bicCountryBlocked(channel)
          ? 'country'
          : bicRestricted
            ? 'restricted'
            : null,
    callIconVisibility: c.callIconVisibility,
    iconCountries: [...c.iconCountries],
    callHours: {
      enabled: c.callHours.enabled,
      timezone: c.callHours.timezone,
      weekly: c.callHours.weekly.map((w) => ({ day: w.day, open: w.open, close: w.close })),
      holidays: c.callHours.holidays.map((h) => ({ date: h.date, start: h.start, end: h.end })),
    },
    callbackPermission: c.callbackPermission,
    inbound: {
      route: c.inbound.route,
      aiProgram: c.inbound.aiProgram
        ? { kind: c.inbound.aiProgram.kind, id: c.inbound.aiProgram.id.toString() }
        : null,
      ringTimeoutSec: c.inbound.ringTimeoutSec,
      ringUserIds: c.inbound.ringUserIds ? c.inbound.ringUserIds.map((id) => id.toString()) : null,
    },
    permissionRequestBody: c.permissionRequestBody,
    restrictions: c.restrictions.map((r) => ({
      type: r.type,
      reason: r.reason,
      expiresAt: iso(r.expiresAt),
      active: !r.expiresAt || r.expiresAt.getTime() > now.getTime(),
    })),
    syncedAt: iso(c.syncedAt),
    lastError: c.lastError,
  };
};
export type CallingView = ReturnType<typeof callingView>;

/** The calling part of channel list items / `whatsapp.channel.updated`. */
export const callingSummary = (channel: WhatsAppChannelDoc, now = new Date()) => {
  const c = channel.calling ?? defaultCalling();
  return {
    status: c.status,
    unavailableReason: c.unavailableReason,
    restricted:
      activeRestrictions(c, 'business', now).length > 0 ||
      activeRestrictions(c, 'user', now).length > 0,
  };
};
