import { ForbiddenException } from '@nestjs/common';
import {
  assertDeviceAllowed,
  assertGroupAllowed,
  assertPersonAllowed,
  assertProjectAllowed,
  freePlanMax,
  isMaster,
  isMasterUserId,
  planLimitsFor,
  resetMasterCache,
  usageRefusal,
} from './plan-limits.js';

const mocks = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  project: { count: vi.fn() },
  group: { count: vi.fn() },
  groupMember: { count: vi.fn() },
  groupInvitation: { count: vi.fn() },
  device: { count: vi.fn() },
  envelopeDelivery: { count: vi.fn(), groupBy: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('../lib/cipseq-prisma.js', () => ({ cipseqPrisma: mocks }));
vi.mock('../lib/prisma.js', () => ({ prisma: { user: mocks.user } }));

const MASTERS = 'Boss@Cipherion.test, ops@cipherion.test';
const master = {
  id: 'master-1',
  email: 'boss@cipherion.test',
  emailVerified: true,
};
const user = { id: 'user-1', email: 'ada@cipherion.test', emailVerified: true };
// The mocked models stand in for a transaction client.
const tx = mocks as never;

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForbiddenException);
  return (error as ForbiddenException).getResponse();
};

describe('plan limits', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('MASTER_EMAILS', MASTERS);
    resetMasterCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('freePlanMax', () => {
    it('uses the defaults when nothing is set', () => {
      vi.stubEnv('FREE_PLAN_MAX_PROJECTS', '');
      expect(freePlanMax('projects')).toBe(1);
      expect(freePlanMax('groupsPerProject')).toBe(2);
      expect(freePlanMax('peoplePerGroup')).toBe(3);
      expect(freePlanMax('devices')).toBe(1);
      expect(freePlanMax('encryptionsPerMonth')).toBe(500);
      expect(freePlanMax('decryptionsPerMonth')).toBe(500);
    });

    it('reads a value from the environment', () => {
      vi.stubEnv('FREE_PLAN_MAX_GROUPS_PER_PROJECT', '5');
      expect(freePlanMax('groupsPerProject')).toBe(5);
    });
  });

  describe('isMaster', () => {
    it('matches any verified master email in the list, ignoring case and spaces', () => {
      expect(isMaster(master)).toBe(true);
      expect(isMaster({ ...user, email: 'Ops@Cipherion.test' })).toBe(true);
      expect(isMaster(user)).toBe(false);
    });

    it('ignores an unverified address', () => {
      expect(isMaster({ ...master, emailVerified: false })).toBe(false);
    });

    it('has no master when MASTER_EMAILS is unset', () => {
      vi.stubEnv('MASTER_EMAILS', '');
      expect(isMaster(master)).toBe(false);
    });
  });

  describe('isMasterUserId', () => {
    it('looks a user up by id and remembers a master', async () => {
      mocks.user.findUnique.mockResolvedValue(master);

      await expect(isMasterUserId(master.id)).resolves.toBe(true);
      await expect(isMasterUserId(master.id)).resolves.toBe(true);
      expect(mocks.user.findUnique).toHaveBeenCalledTimes(1);
      expect(mocks.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: master.id } }),
      );
    });

    it('looks anyone else up again, in case they become a master', async () => {
      mocks.user.findUnique.mockResolvedValue(user);

      await expect(isMasterUserId(user.id)).resolves.toBe(false);
      await expect(isMasterUserId(user.id)).resolves.toBe(false);
      expect(mocks.user.findUnique).toHaveBeenCalledTimes(2);
    });

    it('forgets remembered masters when the list changes', async () => {
      mocks.user.findUnique.mockResolvedValue(master);
      await isMasterUserId(master.id);

      vi.stubEnv('MASTER_EMAILS', 'ops@cipherion.test');
      await expect(isMasterUserId(master.id)).resolves.toBe(false);
    });

    it('never looks anything up when MASTER_EMAILS is unset', async () => {
      vi.stubEnv('MASTER_EMAILS', '');
      await expect(isMasterUserId(master.id)).resolves.toBe(false);
      expect(mocks.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('assertProjectAllowed', () => {
    it('allows a project below the limit', async () => {
      mocks.project.count.mockResolvedValue(0);
      await expect(assertProjectAllowed(user)).resolves.toBeUndefined();
      expect(mocks.project.count).toHaveBeenCalledWith({
        where: { adminUserId: user.id, deletedAt: null },
      });
    });

    it('refuses at the limit with PLAN_LIMIT_REACHED', async () => {
      mocks.project.count.mockResolvedValue(1);
      await expect(refusal(assertProjectAllowed(user))).resolves.toEqual({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PLAN_LIMIT_REACHED',
        limit: 'projects',
        max: 1,
        message: 'The free plan allows 1 project',
      });
    });

    it('takes the user lock first inside a transaction', async () => {
      mocks.project.count.mockResolvedValue(0);
      await assertProjectAllowed(user, tx);
      expect(mocks.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mocks.$executeRaw.mock.calls[0]).toContain(`plan:user:${user.id}`);
      expect(mocks.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.project.count.mock.invocationCallOrder[0],
      );
    });

    it('never limits the master', async () => {
      await assertProjectAllowed(master, tx);
      expect(mocks.project.count).not.toHaveBeenCalled();
      expect(mocks.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('assertGroupAllowed', () => {
    const project = { id: 'project-1', adminUserId: user.id };

    it('counts live groups in the project', async () => {
      mocks.group.count.mockResolvedValue(2);
      const body = await refusal(assertGroupAllowed(project));
      expect(body).toMatchObject({ limit: 'groupsPerProject', max: 2 });
      expect(mocks.group.count).toHaveBeenCalledWith({
        where: { projectId: project.id, deletedAt: null },
      });
    });

    it("never limits the master's projects", async () => {
      mocks.user.findUnique.mockResolvedValue(master);
      await assertGroupAllowed({ ...project, adminUserId: master.id });
      expect(mocks.group.count).not.toHaveBeenCalled();
    });
  });

  describe('assertPersonAllowed', () => {
    it('counts members besides the admin plus open invitations', async () => {
      mocks.groupMember.count.mockResolvedValue(2);
      mocks.groupInvitation.count.mockResolvedValue(1);

      const body = await refusal(assertPersonAllowed('group-1', user.id));

      expect(body).toMatchObject({ limit: 'peoplePerGroup', max: 3 });
      expect(mocks.groupMember.count).toHaveBeenCalledWith({
        where: { groupId: 'group-1', role: { not: 'ADMIN' } },
      });
      expect(mocks.groupInvitation.count).toHaveBeenCalledWith({
        where: {
          groupId: 'group-1',
          status: { in: ['PENDING_APPROVAL', 'PENDING_ACCEPTANCE'] },
        },
      });
    });

    it('leaves out the invitation being accepted', async () => {
      mocks.groupMember.count.mockResolvedValue(2);
      mocks.groupInvitation.count.mockResolvedValue(0);

      await expect(
        assertPersonAllowed('group-1', user.id, tx, 'invitation-1'),
      ).resolves.toBeUndefined();
      expect(mocks.groupInvitation.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: { not: 'invitation-1' } }),
      });
      expect(mocks.$executeRaw.mock.calls[0]).toContain('plan:group:group-1');
    });
  });

  describe('assertDeviceAllowed', () => {
    it('counts active devices other than this one', async () => {
      mocks.device.count.mockResolvedValue(1);

      const body = await refusal(assertDeviceAllowed(user, 'dvc_new'));

      expect(body).toMatchObject({
        limit: 'devices',
        max: 1,
        message: 'The free plan allows 1 device',
      });
      expect(mocks.device.count).toHaveBeenCalledWith({
        where: { userId: user.id, status: 'ACTIVE', id: { not: 'dvc_new' } },
      });
    });
  });

  describe('usageRefusal', () => {
    const now = new Date('2026-11-12T10:00:00.000Z');

    it('counts this month and passes below the limit', async () => {
      mocks.envelopeDelivery.count.mockResolvedValue(499);

      await expect(
        usageRefusal(tx, user.id, 'ENCRYPT', now),
      ).resolves.toBeNull();
      expect(mocks.envelopeDelivery.count).toHaveBeenCalledWith({
        where: {
          userId: user.id,
          operation: 'ENCRYPT',
          createdAt: { gte: new Date('2026-11-01T00:00:00.000Z') },
        },
      });
      expect(mocks.$executeRaw.mock.calls[0]).toContain(
        `plan:usage:${user.id}`,
      );
    });

    it('returns a refusal with the reset time at the limit', async () => {
      vi.stubEnv('FREE_PLAN_MAX_DECRYPTIONS_PER_MONTH', '2');
      mocks.envelopeDelivery.count.mockResolvedValue(2);

      const refused = await usageRefusal(tx, user.id, 'DECRYPT', now);

      expect(refused).toBeInstanceOf(ForbiddenException);
      expect(refused?.getResponse()).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        limit: 'decryptionsPerMonth',
        max: 2,
        message: 'The free plan allows 2 decryptions a month',
        resetsAt: '2026-12-01T00:00:00.000Z',
      });
    });
  });

  describe('planLimitsFor', () => {
    const now = new Date('2026-12-31T23:00:00.000Z');

    beforeEach(() => {
      mocks.project.count.mockResolvedValue(1);
      mocks.device.count.mockResolvedValue(2);
      mocks.envelopeDelivery.groupBy.mockResolvedValue([
        { operation: 'ENCRYPT', _count: { _all: 7 } },
      ]);
    });

    it('gives the free-plan maximums and what is used', async () => {
      await expect(planLimitsFor(user, now)).resolves.toEqual({
        master: false,
        projects: { max: 1, used: 1 },
        groupsPerProject: 2,
        peoplePerGroup: 3,
        devices: { max: 1, used: 2 },
        encryptions: {
          max: 500,
          used: 7,
          resetsAt: new Date('2027-01-01T00:00:00.000Z'),
        },
        decryptions: {
          max: 500,
          used: 0,
          resetsAt: new Date('2027-01-01T00:00:00.000Z'),
        },
      });
    });

    it('gives the master no maximums', async () => {
      const limits = await planLimitsFor(master, now);
      expect(limits).toMatchObject({
        master: true,
        projects: { max: null, used: 1 },
        groupsPerProject: null,
        peoplePerGroup: null,
        devices: { max: null },
        encryptions: { max: null, used: 7 },
      });
    });
  });
});
