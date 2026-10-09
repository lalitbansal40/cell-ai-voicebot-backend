import { BILLING_LIMITS } from '../../config/limits';
import { TopupOrderModel } from '../../db/models/topup-order.model';

/**
 * Hourly: unpaid orders older than 24 h → `expired` (a late payment still
 * credits); orders stuck in `creating` > 1 h (crash between our save and the
 * gateway call) → `failed`.
 */
export const expireTopupOrders = async (
  now = new Date(),
): Promise<{ expired: number; stuck: number }> => {
  const expired = await TopupOrderModel.updateMany(
    {
      status: 'created',
      createdAt: { $lt: new Date(now.getTime() - BILLING_LIMITS.orderExpiryMs) },
    },
    { $set: { status: 'expired' } },
  );
  const stuck = await TopupOrderModel.updateMany(
    {
      status: 'creating',
      createdAt: { $lt: new Date(now.getTime() - BILLING_LIMITS.stuckCreatingMs) },
    },
    { $set: { status: 'failed', failureReason: 'stuck_creating' } },
  );
  return { expired: expired.modifiedCount, stuck: stuck.modifiedCount };
};
