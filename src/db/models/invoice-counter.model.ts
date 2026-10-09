import mongoose, { Schema, type Model } from 'mongoose';

export interface InvoiceCounterDoc {
  /** Financial year, e.g. `26-27`. */
  _id: string;
  seq: number;
}

const schema = new Schema<InvoiceCounterDoc>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { versionKey: false },
);

/** Next invoice number per financial year, `$inc` inside the credit transaction. */
export const InvoiceCounterModel: Model<InvoiceCounterDoc> =
  (mongoose.models.InvoiceCounter as Model<InvoiceCounterDoc> | undefined) ??
  mongoose.model<InvoiceCounterDoc>('InvoiceCounter', schema, 'invoiceCounters');
