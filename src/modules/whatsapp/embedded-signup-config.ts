import { Types } from 'mongoose';

import { PlatformSettingsModel } from '../../db/models/platform-settings.model';

export interface WhatsAppEmbeddedSignupSettings {
  solutionId: string | null;
}

const DEFAULT_SETTINGS: WhatsAppEmbeddedSignupSettings = { solutionId: null };

export const getWhatsAppEmbeddedSignupSettings =
  async (): Promise<WhatsAppEmbeddedSignupSettings> => {
    const row = await PlatformSettingsModel.findOne({ key: 'whatsappEmbeddedSignup' })
      .select({ value: 1 })
      .lean<{ value?: WhatsAppEmbeddedSignupSettings }>();
    return row?.value ?? DEFAULT_SETTINGS;
  };

export const getWhatsAppSolutionId = async (): Promise<string | null> =>
  (await getWhatsAppEmbeddedSignupSettings()).solutionId;

export const setWhatsAppSolutionId = async (
  solutionId: string | null,
  updatedBy: string | null,
): Promise<void> => {
  await PlatformSettingsModel.updateOne(
    { key: 'whatsappEmbeddedSignup' },
    {
      $set: {
        value: { solutionId },
        updatedBy: updatedBy ? new Types.ObjectId(updatedBy) : null,
      },
    },
    { upsert: true, runValidators: true },
  );
};
