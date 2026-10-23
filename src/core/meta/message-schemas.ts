import { z } from 'zod';

import type { MetaBlockResult, MetaBusinessProfile, MetaMediaUrl } from './types';

/**
 * Phase 10 Meta shapes — Graph answers for messaging / media / profile / block and
 * the `messages` webhook value (Cloud API webhooks reference, payload examples).
 * Loose objects: Meta adds fields over time.
 */
const optStr = z.string().nullish();
const optNum = z.number().nullish();

/* ── Graph answers ── */

export const sendMessageSchema = z.looseObject({
  messages: z.array(z.looseObject({ id: z.string().min(1) })).min(1),
});

export const mediaUploadSchema = z.looseObject({ id: z.string().min(1) });

export const mediaUrlSchema = z.looseObject({
  url: z.string().min(1),
  mime_type: optStr,
  sha256: optStr,
  file_size: z.union([z.number(), z.string()]).nullish(),
  id: optStr,
});

export const toMediaUrl = (raw: z.infer<typeof mediaUrlSchema>): MetaMediaUrl => {
  const size = raw.file_size === null || raw.file_size === undefined ? null : Number(raw.file_size);
  return {
    url: raw.url,
    mimeType: raw.mime_type ?? null,
    sha256: raw.sha256 ?? null,
    size: Number.isFinite(size) ? size : null,
  };
};

export const businessProfileSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        about: optStr,
        address: optStr,
        description: optStr,
        email: optStr,
        profile_picture_url: optStr,
        websites: z.array(z.string()).nullish(),
        vertical: optStr,
      }),
    )
    .min(1),
});

export const toBusinessProfile = (
  raw: z.infer<typeof businessProfileSchema>,
): MetaBusinessProfile => {
  const p = raw.data[0];
  return {
    about: p?.about ?? null,
    address: p?.address ?? null,
    description: p?.description ?? null,
    email: p?.email ?? null,
    profilePictureUrl: p?.profile_picture_url ?? null,
    websites: p?.websites ?? [],
    vertical: p?.vertical ?? null,
  };
};

const blockUserSchema = z.looseObject({ input: optStr, wa_id: optStr });
const blockErrorSchema = z.looseObject({ message: optStr, code: optNum });

export const blockUsersSchema = z.looseObject({
  messaging_product: optStr,
  block_users: z
    .looseObject({
      added_users: z.array(blockUserSchema).nullish(),
      removed_users: z.array(blockUserSchema).nullish(),
      failed_users: z
        .array(blockUserSchema.extend({ errors: z.array(blockErrorSchema).nullish() }))
        .nullish(),
    })
    .nullish(),
});

export const toBlockResult = (raw: z.infer<typeof blockUsersSchema>): MetaBlockResult => {
  const b = raw.block_users;
  const ok = [...(b?.added_users ?? []), ...(b?.removed_users ?? [])];
  return {
    done: ok.map((u) => u.wa_id ?? u.input ?? '').filter(Boolean),
    failed: (b?.failed_users ?? []).map((u) => ({
      waId: u.wa_id ?? u.input ?? '',
      code: u.errors?.[0]?.code ?? null,
      message: u.errors?.[0]?.message ?? 'Meta refused the request',
    })),
  };
};

export const uploadSessionSchema = z.looseObject({ id: z.string().min(1) });
export const uploadHandleSchema = z.looseObject({ h: z.string().min(1) });

/* ── `messages` webhook value ── */

export const inboundMediaSchema = z.looseObject({
  id: z.string().min(1),
  mime_type: optStr,
  sha256: optStr,
  caption: optStr,
  filename: optStr,
  voice: z.boolean().nullish(),
  animated: z.boolean().nullish(),
});

const contactCardSchema = z.looseObject({
  name: z.looseObject({ formatted_name: optStr, first_name: optStr, last_name: optStr }).nullish(),
  phones: z.array(z.looseObject({ phone: optStr, type: optStr, wa_id: optStr })).nullish(),
  emails: z.array(z.looseObject({ email: optStr, type: optStr })).nullish(),
  org: z.looseObject({ company: optStr }).nullish(),
});

export const metaErrorItemSchema = z.looseObject({
  code: optNum,
  title: optStr,
  message: optStr,
  error_data: z.looseObject({ details: optStr }).nullish(),
});

export const inboundContextSchema = z.looseObject({
  from: optStr,
  id: optStr,
  forwarded: z.boolean().nullish(),
  frequently_forwarded: z.boolean().nullish(),
});

export const referralSchema = z.looseObject({
  source_url: optStr,
  source_type: optStr,
  source_id: optStr,
  headline: optStr,
  body: optStr,
  ctwa_clid: optStr,
});

/** One inbound (or echoed / history) message — every type Meta documents. */
export const inboundMessageSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  /** Echoes only: the customer. */
  to: optStr,
  timestamp: z.union([z.string(), z.number()]),
  type: z.string().min(1),
  context: inboundContextSchema.nullish(),
  referral: referralSchema.nullish(),
  errors: z.array(metaErrorItemSchema).nullish(),
  text: z.looseObject({ body: z.string() }).nullish(),
  image: inboundMediaSchema.nullish(),
  video: inboundMediaSchema.nullish(),
  audio: inboundMediaSchema.nullish(),
  document: inboundMediaSchema.nullish(),
  sticker: inboundMediaSchema.nullish(),
  location: z
    .looseObject({
      latitude: z.number(),
      longitude: z.number(),
      name: optStr,
      address: optStr,
      url: optStr,
    })
    .nullish(),
  contacts: z.array(contactCardSchema).nullish(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: optStr, title: optStr }).nullish(),
      list_reply: z.looseObject({ id: optStr, title: optStr, description: optStr }).nullish(),
      nfm_reply: z.looseObject({ response_json: optStr, body: optStr, name: optStr }).nullish(),
    })
    .nullish(),
  button: z.looseObject({ payload: optStr, text: optStr }).nullish(),
  reaction: z.looseObject({ message_id: z.string(), emoji: optStr }).nullish(),
  order: z
    .looseObject({
      catalog_id: optStr,
      text: optStr,
      product_items: z
        .array(
          z.looseObject({
            product_retailer_id: optStr,
            quantity: z.union([z.number(), z.string()]).nullish(),
            item_price: z.union([z.number(), z.string()]).nullish(),
            currency: optStr,
          }),
        )
        .nullish(),
    })
    .nullish(),
  system: z
    .looseObject({
      body: optStr,
      type: optStr,
      new_wa_id: optStr,
      wa_id: optStr,
      identity: optStr,
      customer: optStr,
    })
    .nullish(),
  /** History chunks: the message's status at export time. */
  history_context: z.looseObject({ status: optStr }).nullish(),
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

export const statusSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: z.union([z.string(), z.number()]),
  recipient_id: optStr,
  conversation: z
    .looseObject({
      id: optStr,
      origin: z.looseObject({ type: optStr }).nullish(),
      expiration_timestamp: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
  pricing: z
    .looseObject({
      billable: z.boolean().nullish(),
      pricing_model: optStr,
      category: optStr,
      type: optStr,
      /** `paid_exempt` etc. (Meta, from 12 Oct 2026). */
      subtype: optStr,
    })
    .nullish(),
  errors: z.array(metaErrorItemSchema).nullish(),
});
export type MetaStatus = z.infer<typeof statusSchema>;

export const profileContactSchema = z.looseObject({
  wa_id: z.string().min(1),
  profile: z.looseObject({ name: optStr }).nullish(),
});

/**
 * `messages` value. Messages stay `unknown` here: each one is parsed on its own so one
 * odd message is stored as `unsupported` instead of failing the whole event.
 */
export const inboxMessagesValueSchema = z.looseObject({
  messaging_product: optStr,
  metadata: z.looseObject({ phone_number_id: z.string(), display_phone_number: optStr }),
  contacts: z.array(profileContactSchema).nullish(),
  messages: z.array(z.unknown()).nullish(),
  statuses: z.array(statusSchema).nullish(),
  errors: z.array(metaErrorItemSchema).nullish(),
});

/** Coexistence: messages the business sent from the WhatsApp Business app. */
export const inboxEchoesValueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string(), display_phone_number: optStr }).nullish(),
  message_echoes: z.array(z.unknown()).min(1),
});

/** Coexistence history chunk: threads of past messages. */
export const historyChunkSchema = z.looseObject({
  metadata: z.looseObject({ phase: optNum, chunk_order: optNum, progress: optNum }).nullish(),
  threads: z
    .array(z.looseObject({ id: z.string(), messages: z.array(z.unknown()).nullish() }))
    .nullish(),
  errors: z.array(metaErrorItemSchema).nullish(),
});

export const inboxHistoryValueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }).nullish(),
  history: z.array(historyChunkSchema).min(1),
});

/** Coexistence: phone contacts added / removed in the WhatsApp Business app. */
export const inboxStateSyncValueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }).nullish(),
  state_sync: z
    .array(
      z.looseObject({
        type: z.string(),
        action: optStr,
        contact: z
          .looseObject({ full_name: optStr, first_name: optStr, phone_number: optStr })
          .nullish(),
        metadata: z
          .looseObject({ timestamp: z.union([z.string(), z.number()]).nullish() })
          .nullish(),
      }),
    )
    .min(1),
});

/** Meta timestamps are unix seconds (string or number). */
export const metaTime = (value: string | number | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
};
