import { FAKE_META_APP_ID, isMetaApiError, type MetaClient } from '../../core/meta';
import { WEBHOOK_FIELDS, WEBHOOK_OBJECT } from '../../core/meta/schemas';
import type { WaWebhookState } from '../../db/models/whatsapp-channel.model';

import type { WhatsAppContext } from './context';

/**
 * SAC-T4: does Meta deliver a number's events to us? (a) our app is subscribed to the WABA
 * (`GET /{waba}/subscribed_apps`), (b) the app webhook (`GET /{app}/subscriptions`) has the
 * fields we need. `fix` repairs what is missing: `POST /{waba}/subscribed_apps` and
 * `POST /{app}/subscriptions` with every field of `WEBHOOK_FIELDS`, then checks again.
 * Meta numbers only — a managed (Pinnacle) number's webhook is the partner's `setwebhook`.
 */

/** Without these a number can't chat or take calls. */
export const REQUIRED_WEBHOOK_FIELDS = ['messages', 'calls'] as const;

export type WebhookStepKey = 'app_subscribed' | 'fields' | 'fix_app' | 'fix_fields';
export interface WebhookStep {
  key: WebhookStepKey;
  ok: boolean;
  detail: string | null;
}
export interface WebhookCheck {
  state: WaWebhookState;
  steps: WebhookStep[];
  /** A repair was sent (fix mode). */
  repaired: boolean;
}

const message = (err: unknown): string =>
  (isMetaApiError(err) || err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Our app id as Meta reports it (the fake has no `META_APP_ID`). */
export const ourAppId = (ctx: Pick<WhatsAppContext, 'env' | 'meta'>): string =>
  ctx.meta.provider === 'fake' ? FAKE_META_APP_ID : (ctx.env.META_APP_ID ?? '');

const read = async (
  ctx: Pick<WhatsAppContext, 'env' | 'meta'>,
  meta: MetaClient,
  token: string,
  wabaId: string,
) => {
  const apps = await meta.getSubscribedApps(token, wabaId);
  const appSubscribed = apps.some((a) => a.appId === ourAppId(ctx));
  const subs = await meta.getAppSubscriptions();
  const waba = subs.find((s) => s.object === WEBHOOK_OBJECT && s.active);
  const have = new Set(waba?.fields ?? []);
  const missingFields = WEBHOOK_FIELDS.filter((f) => !have.has(f));
  return { appSubscribed, missingFields };
};

export const checkWebhook = async (
  ctx: Pick<WhatsAppContext, 'env' | 'meta'>,
  channel: { wabaId: string; webhookCheck?: WaWebhookState | null },
  token: string,
  options: { fix: boolean; now: Date },
): Promise<WebhookCheck> => {
  const { meta } = ctx;
  const steps: WebhookStep[] = [];
  let repaired = false;
  let error: string | null = null;
  let facts: { appSubscribed: boolean; missingFields: string[] } | null = null;
  try {
    facts = await read(ctx, meta, token, channel.wabaId);
    if (options.fix && !facts.appSubscribed) {
      try {
        await meta.subscribeApp(token, channel.wabaId);
        steps.push({ key: 'fix_app', ok: true, detail: null });
      } catch (err) {
        if (isMetaApiError(err) && err.tokenInvalid) throw err;
        steps.push({ key: 'fix_app', ok: false, detail: message(err) });
      }
      repaired = true;
    }
    const required = (f: string) => (REQUIRED_WEBHOOK_FIELDS as readonly string[]).includes(f);
    // repair only when a field we need is missing (the repair then sends every field we use)
    if (options.fix && facts.missingFields.some(required)) {
      try {
        await meta.setAppSubscription({
          object: WEBHOOK_OBJECT,
          callbackUrl: `${ctx.env.APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/meta`,
          verifyToken: ctx.env.META_WEBHOOK_VERIFY_TOKEN,
          fields: WEBHOOK_FIELDS,
        });
        steps.push({ key: 'fix_fields', ok: true, detail: null });
      } catch (err) {
        if (isMetaApiError(err) && err.tokenInvalid) throw err;
        steps.push({ key: 'fix_fields', ok: false, detail: message(err) });
      }
      repaired = true;
    }
    if (repaired) facts = await read(ctx, meta, token, channel.wabaId);
    steps.unshift(
      {
        key: 'app_subscribed',
        ok: facts.appSubscribed,
        detail: facts.appSubscribed
          ? null
          : "Our app doesn't receive this WhatsApp account's events.",
      },
      {
        key: 'fields',
        ok: !facts.missingFields.some(required),
        detail: facts.missingFields.length ? `Missing: ${facts.missingFields.join(', ')}` : null,
      },
    );
  } catch (err) {
    if (isMetaApiError(err) && err.tokenInvalid) throw err;
    error = message(err);
  }
  const ok =
    !error &&
    Boolean(facts?.appSubscribed) &&
    !facts?.missingFields.some((f) => (REQUIRED_WEBHOOK_FIELDS as readonly string[]).includes(f));
  return {
    steps,
    repaired,
    state: {
      status: error ? (channel.webhookCheck?.status ?? 'unknown') : ok ? 'ok' : 'failed',
      appSubscribed: facts?.appSubscribed ?? null,
      missingFields: facts?.missingFields ?? [],
      checkedAt: options.now,
      fixedAt: repaired && ok ? options.now : (channel.webhookCheck?.fixedAt ?? null),
      error,
    },
  };
};
