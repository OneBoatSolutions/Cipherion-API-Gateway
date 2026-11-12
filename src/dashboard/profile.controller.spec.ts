import { HttpException } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth/auth.types.js';
import { ProfileController } from './profile.controller.js';

const { updateUser, findUniqueOrThrow, accountFindUnique } = vi.hoisted(
  () => ({
    updateUser: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    accountFindUnique: vi.fn(),
  }),
);

vi.mock('../auth.js', () => ({ auth: { api: { updateUser } } }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUniqueOrThrow },
    accountProfile: { findUnique: accountFindUnique },
  },
}));

describe('ProfileController', () => {
  const controller = new ProfileController();
  const request = { headers: { cookie: 'session=abc' } } as FastifyRequest;
  const createdAt = new Date('2026-11-03T06:36:46.000Z');
  const user = {
    id: 'user-1',
    name: 'Ada',
    email: 'ada@cipherion.com',
    emailVerified: true,
    createdAt,
    updatedAt: createdAt,
  } as AuthUser;
  const saved = {
    id: 'user-1',
    name: 'Ada',
    email: 'ada@cipherion.com',
    emailVerified: true,
    createdAt,
  };
  const profile = { ...saved, accountType: null, companyName: null };

  beforeEach(() => {
    updateUser.mockReset().mockResolvedValue({ status: true });
    findUniqueOrThrow.mockReset();
    accountFindUnique.mockReset().mockResolvedValue(null);
  });

  it('returns the profile from the session', async () => {
    await expect(controller.get(user)).resolves.toEqual(profile);
  });

  it('includes the chosen account type', async () => {
    accountFindUnique.mockResolvedValue({
      accountType: 'INDIVIDUAL',
      companyName: null,
      createdAt,
    });

    await expect(controller.get(user)).resolves.toEqual({
      ...profile,
      accountType: 'INDIVIDUAL',
    });
  });

  it('updates the name through Better Auth and returns the saved profile', async () => {
    findUniqueOrThrow.mockResolvedValue({ ...saved, name: 'Ada L.' });

    await expect(
      controller.update(request, user, { name: 'Ada L.' }),
    ).resolves.toEqual({ ...profile, name: 'Ada L.' });
    expect(updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: { name: 'Ada L.' } }),
    );
  });

  it('skips Better Auth when nothing was sent', async () => {
    await expect(controller.update(request, user, {})).resolves.toEqual(
      profile,
    );
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("passes Better Auth's status through, e.g. 503 when Redis is down", async () => {
    updateUser.mockRejectedValue(
      new APIError('SERVICE_UNAVAILABLE', { message: 'Unavailable' }),
    );

    const error = await controller
      .update(request, user, { name: 'Ada L.' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
  });
});
