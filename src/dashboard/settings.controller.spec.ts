import type { AuthUser } from '../auth/auth.types.js';
import { SettingsController } from './settings.controller.js';
import { DEFAULT_SETTINGS } from './settings.dto.js';

const { findUnique, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { userSettings: { findUnique, upsert } },
}));

describe('SettingsController', () => {
  const controller = new SettingsController();
  const user = { id: 'user-1' } as AuthUser;
  const saved = {
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    securityAlerts: false,
  };

  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('returns the saved settings', async () => {
    findUnique.mockResolvedValue(saved);

    await expect(controller.get(user)).resolves.toEqual(saved);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('returns the defaults when the user has no settings yet', async () => {
    findUnique.mockResolvedValue(null);

    await expect(controller.get(user)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('upserts only the fields that were sent', async () => {
    upsert.mockResolvedValue({ ...DEFAULT_SETTINGS, locale: 'en-IN' });

    await expect(controller.update(user, { locale: 'en-IN' })).resolves.toEqual(
      { ...DEFAULT_SETTINGS, locale: 'en-IN' },
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        create: { userId: 'user-1', locale: 'en-IN' },
        update: { locale: 'en-IN' },
      }),
    );
  });
});
