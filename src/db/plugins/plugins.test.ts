import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestMongo } from '../../../tests/helpers/mongo';

import { basePlugin } from './base';
import { softDeletePlugin, type SoftDeleteDoc } from './soft-delete';
import { tenantPlugin } from './tenant';

interface Thing extends SoftDeleteDoc {
  accountId: Types.ObjectId;
  name: string;
}

const schema = new Schema<Thing>({ name: { type: String, required: true } });
schema.plugin(basePlugin);
schema.plugin(tenantPlugin);
schema.plugin(softDeletePlugin);
const ThingModel = mongoose.model<Thing>('PluginTestThing', schema);

describe('db plugins', () => {
  let stop: () => Promise<void>;
  const accountId = new Types.ObjectId();

  beforeAll(async () => {
    const mongo = await startTestMongo();
    stop = mongo.stop;
    await mongoose.connect(mongo.uri);
    await ThingModel.syncIndexes();
  });

  afterAll(async () => {
    await stop();
  });

  it('basePlugin adds timestamps and an API-friendly JSON shape', async () => {
    const doc = await ThingModel.create({ accountId, name: 'a' });
    const json = doc.toJSON() as unknown as Record<string, unknown>;
    expect(json.id).toBe(String(doc._id));
    expect(json._id).toBeUndefined();
    expect(json.__v).toBeUndefined();
    expect(json.createdAt).toBeInstanceOf(Date);
  });

  it('tenantPlugin requires and indexes accountId', async () => {
    await expect(ThingModel.create({ name: 'no-account' })).rejects.toThrow(/accountId/);
    const indexes = await ThingModel.collection.indexes();
    expect(indexes.some((i) => Object.keys(i.key).join() === 'accountId')).toBe(true);
  });

  it('softDeletePlugin hides deleted docs from find / findOne / count / aggregate', async () => {
    const keep = await ThingModel.create({ accountId, name: 'keep' });
    const gone = await ThingModel.create({ accountId, name: 'gone' });
    await gone.softDelete();

    const names = (await ThingModel.find({ accountId })).map((d) => d.name);
    expect(names).toContain('keep');
    expect(names).not.toContain('gone');
    expect(await ThingModel.findOne({ _id: gone._id })).toBeNull();
    expect(await ThingModel.countDocuments({ _id: { $in: [keep._id, gone._id] } })).toBe(1);
    const agg = await ThingModel.aggregate<{ name: string }>([
      { $match: { _id: { $in: [keep._id, gone._id] } } },
    ]);
    expect(agg.map((d) => d.name)).toEqual(['keep']);
  });

  it('withDeleted shows deleted docs and restore brings them back', async () => {
    const doc = await ThingModel.create({ accountId, name: 'restore-me' });
    await doc.softDelete();
    expect(
      await ThingModel.findOne({ _id: doc._id }).setOptions({ withDeleted: true }),
    ).not.toBeNull();
    expect(
      await ThingModel.aggregate([{ $match: { _id: doc._id } }]).option({
        withDeleted: true,
      }),
    ).toHaveLength(1);
    await (ThingModel as unknown as { restore: (id: unknown) => Promise<unknown> }).restore(
      doc._id,
    );
    expect(await ThingModel.findOne({ _id: doc._id })).not.toBeNull();
  });
});
