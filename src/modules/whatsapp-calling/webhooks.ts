import type { InboxCallingHook } from '../inbox/context';
import type { CallingHooks } from '../whatsapp/webhook-handlers';

import type { CallPermissionsService } from './permissions.service';
import type { CallingSettingsService } from './settings.service';

/**
 * The calling module's webhook consumers for the WhatsApp worker (`HandlerContext.calling`)
 * and the inbox (`InboxContext.calling`): call settings changes, calling restrictions,
 * permission replies and the contact panel state. `calls` events join in T12.6.
 */
export const createCallingHooks = (deps: {
  settings: CallingSettingsService;
  calls?: CallingHooks['calls'];
}): CallingHooks => ({
  settingsUpdate: (channel) => deps.settings.onSettingsWebhook(channel),
  accountUpdate: (channel, value) => deps.settings.onAccountUpdate(channel, value),
  ...(deps.calls ? { calls: deps.calls } : {}),
});

export const createInboxCallingHook = (permissions: CallPermissionsService): InboxCallingHook => ({
  onPermissionReply: (input) => permissions.onReply(input),
  permissionPanel: (input) =>
    permissions.statusFor(input.accountId, input.channelId, input.contactId),
});
