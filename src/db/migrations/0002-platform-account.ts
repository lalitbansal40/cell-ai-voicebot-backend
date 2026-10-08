import type { Migration } from '../migrate';

/** The internal `platform` account that holds superadmins (PHASE_2_PLAN §1b). */
export const platformAccount: Migration = {
  name: '0002-platform-account',
  up: async (db) => {
    const now = new Date();
    await db.collection('accounts').updateOne(
      { slug: 'platform' },
      {
        $setOnInsert: {
          name: 'Platform',
          slug: 'platform',
          status: 'active',
          isPlatform: true,
          ownerId: null,
          timezone: 'Asia/Kolkata',
          country: 'IN',
          defaultLanguage: 'en',
          settings: {
            callingWindow: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
            recordingEnabled: true,
            aiDisclosureEnabled: true,
          },
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  },
  down: async (db) => {
    const platform = await db.collection('accounts').findOne({ slug: 'platform' });
    if (!platform) return;
    if (await db.collection('users').countDocuments({ accountId: platform._id })) {
      throw new Error('Platform account still has users (superadmins) — remove them first');
    }
    await db.collection('roles').deleteMany({ accountId: platform._id });
    await db.collection('accounts').deleteOne({ _id: platform._id });
  },
};
