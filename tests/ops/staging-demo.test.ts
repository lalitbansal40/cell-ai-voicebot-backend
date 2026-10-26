import { beforeAll, describe, expect, it } from 'vitest';

import {
  checkDemoInput,
  DEMO_ACCOUNT,
  DEMO_CREDIT_KEY,
  DEMO_CREDIT_MICROS,
  stagingDemo,
  type DemoDeps,
} from '../../scripts/staging-demo';
import { createFakeProvider } from '../../src/core/ai';
import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { UserModel } from '../../src/db/models/user.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { expectWalletConsistent } from '../helpers/billing';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';

useTestDb();
const storage = useTempStorage();

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});

const input = {
  confirmHost: 'staging.example.com',
  ownerEmail: 'Review@Example.com',
  ownerPassword: 'Mango-Orbit-Lantern-4417',
  testPhones: '+91 98765 43210, 9123456780',
};
const deps = (over: Partial<DemoDeps> = {}): DemoDeps => ({
  env: {
    NODE_ENV: 'production',
    APP_URL: 'https://staging.example.com',
    MOCK_APIS_ENABLED: false,
    OPENAI_TEXT_MODEL: 'gpt-4.1-mini',
  },
  storage,
  provider: createFakeProvider(),
  ...over,
});

describe('staging:demo guards', () => {
  it('runs only in production, for the right host, with an owner e-mail and a long password', () => {
    expect(() =>
      checkDemoInput(input, { env: { ...deps().env, NODE_ENV: 'development' } }),
    ).toThrow('NODE_ENV=production');
    expect(
      checkDemoInput(input, {
        env: { ...deps().env, NODE_ENV: 'development' },
        allowNonProduction: true,
      }).phones,
    ).toHaveLength(2);
    expect(() => checkDemoInput({ ...input, confirmHost: 'other.example.com' }, deps())).toThrow(
      'DEMO_SEED_CONFIRM',
    );
    expect(() => checkDemoInput({ ...input, confirmHost: undefined }, deps())).toThrow(
      'DEMO_SEED_CONFIRM',
    );
    expect(() =>
      checkDemoInput(input, { env: { NODE_ENV: 'production' } as DemoDeps['env'] }),
    ).toThrow('DEMO_SEED_CONFIRM');
    expect(() => checkDemoInput({ ...input, ownerEmail: 'nope' }, deps())).toThrow(
      'DEMO_OWNER_EMAIL',
    );
    expect(() => checkDemoInput({ ...input, ownerPassword: 'short' }, deps())).toThrow(
      'at least 16',
    );
    expect(() => checkDemoInput({ ...input, testPhones: '12' }, deps())).toThrow(
      'DEMO_TEST_PHONES',
    );
    expect(checkDemoInput({ ...input, testPhones: undefined }, deps())).toEqual({
      phones: [],
      ownerEmail: 'review@example.com',
      password: input.ownerPassword,
    });
    expect(checkDemoInput(input, deps()).phones).toEqual(['+919876543210', '+919123456780']);
  });
});

describe('staging:demo', () => {
  it('builds the review account once: users, contacts + test phones, agent, flow, test money', async () => {
    const first = await stagingDemo(input, deps());
    expect(first).toMatchObject({
      usersCreated: ['owner', 'admin', 'agent'],
      testContacts: 2,
      agents: 2,
      knowledgeReady: 3,
      flows: 2, // Loan recovery (published) + Customer feedback (draft)
      credited: true,
    });
    const account = await AccountModel.findOne({ slug: DEMO_ACCOUNT.slug }).lean();
    expect(account?.name).toBe(DEMO_ACCOUNT.name);
    const emails = (await UserModel.find({ accountId: account?._id }).lean()).map((u) => u.email);
    expect(emails.sort()).toEqual([
      'review+admin@example.com',
      'review+agent@example.com',
      'review@example.com',
    ]);
    expect(await ContactModel.countDocuments({ accountId: account?._id, tags: 'review' })).toBe(2);
    const tester = await ContactModel.findOne({ accountId: account?._id, tags: 'review' }).lean();
    expect(tester?.variables).toMatchObject({ loan_amount: 50_000 * 1_000_000 });
    expect(tester?.dnd).toBe(false);
    expect(
      await AiAgentModel.exists({ accountId: account?._id, name: 'Recovery Bot (Hinglish)' }),
    ).toBeTruthy();
    expect(
      await FlowModel.findOne({ accountId: account?._id, name: 'Loan recovery' }).lean(),
    ).toMatchObject({ status: 'published' });
    // no fake WhatsApp data on staging
    expect(await WhatsAppChannelModel.countDocuments({ accountId: account?._id })).toBe(0);

    // twice → nothing new, money credited once (engine idempotency)
    const again = await stagingDemo(input, deps());
    expect(again).toMatchObject({
      usersCreated: [],
      contacts: 0,
      testContacts: 0,
      agents: 0,
      flows: 0,
      credited: false,
    });
    const credits = await LedgerEntryModel.find({
      accountId: account?._id,
      idempotencyKey: DEMO_CREDIT_KEY,
    }).lean();
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountMicros).toBe(DEMO_CREDIT_MICROS);
    expect(await WalletModel.exists({ accountId: account?._id })).toBeTruthy();
    await expectWalletConsistent(account!._id);
  });
});
