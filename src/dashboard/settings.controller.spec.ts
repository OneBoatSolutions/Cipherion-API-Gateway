import type { AuthUser } from '../auth/auth.types.js';
import { SettingsController } from './settings.controller.js';
import { DEFAULT_SETTINGS } from './settings.dto.js';

const { findUnique, upsert, accountFindUnique } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  accountFindUnique: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    userSettings: { findUnique, upsert },
    accountProfile: { findUnique: accountFindUnique },
  },
}));

describe('SettingsController', () => {
  const controller = new SettingsController();
  const user = { id: 'user-1' } as AuthUser;
  const saved = {
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    securityAlerts: false,
  };
  const notChosen = { accountType: null, companyName: null };

  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
    accountFindUnique.mockReset().mockResolvedValue(null);
  });

  it('returns the saved settings', async () => {
    findUnique.mockResolvedValue(saved);

    await expect(controller.get(user)).resolves.toEqual({
      ...saved,
      ...notChosen,
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('returns the defaults when the user has no settings yet', async () => {
    findUnique.mockResolvedValue(null);

    await expect(controller.get(user)).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      ...notChosen,
    });
  });

  it('includes the chosen account type', async () => {
    findUnique.mockResolvedValue(saved);
    accountFindUnique.mockResolvedValue({
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
      createdAt: new Date(),
    });

    await expect(controller.get(user)).resolves.toEqual({
      ...saved,
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
    });
    expect(accountFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('upserts only the fields that were sent', async () => {
    upsert.mockResolvedValue({ ...DEFAULT_SETTINGS, locale: 'en-IN' });

    await expect(controller.update(user, { locale: 'en-IN' })).resolves.toEqual(
      { ...DEFAULT_SETTINGS, locale: 'en-IN', ...notChosen },
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
