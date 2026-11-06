import { ServiceUnavailableException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { WorkspaceController } from './workspace.controller.js';

const mocks = vi.hoisted(() => ({
  project: { findMany: vi.fn() },
  group: { findMany: vi.fn() },
  groupInvitation: { findMany: vi.fn() },
  groupDevice: { findMany: vi.fn() },
  deviceEnvelope: { groupBy: vi.fn() },
  device: { findMany: vi.fn() },
  userSettings: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    project: mocks.project,
    group: mocks.group,
    groupInvitation: mocks.groupInvitation,
    groupDevice: mocks.groupDevice,
    deviceEnvelope: mocks.deviceEnvelope,
    device: mocks.device,
  },
}));
vi.mock('../lib/prisma.js', () => ({
  prisma: { userSettings: mocks.userSettings, user: mocks.user },
}));

const date = new Date('2026-11-05T06:36:46.000Z');
const user = {
  id: 'user-1',
  name: 'Ada',
  email: 'ada@cipherion.test',
  emailVerified: true,
  createdAt: date,
  updatedAt: date,
  image: null,
} as AuthUser;

const projectRow = (id: string, adminUserId: string) => ({
  id,
  name: 'Payments',
  description: 'Card and invoice data',
  adminUserId,
  createdAt: date,
  updatedAt: date,
  keys: { currentKeyVersion: 2 },
});

const groupRow = (
  id: string,
  projectId: string,
  members: { userId: string; role: string; createdAt: Date }[],
) => ({
  id,
  projectId,
  name: 'Finance',
  description: 'Invoices and payroll',
  createdAt: date,
  updatedAt: date,
  keys: { currentGdekVersion: 3, updatedAt: date },
  members,
});

describe('WorkspaceController', () => {
  const controller = new WorkspaceController();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.userSettings.findUnique.mockResolvedValue(null);
    mocks.project.findMany.mockResolvedValue([]);
    mocks.group.findMany.mockResolvedValue([]);
    mocks.groupInvitation.findMany.mockResolvedValue([]);
    mocks.groupDevice.findMany.mockResolvedValue([]);
    mocks.deviceEnvelope.groupBy.mockResolvedValue([]);
    mocks.device.findMany.mockResolvedValue([]);
    mocks.user.findMany.mockResolvedValue([]);
  });

  it('shows an invitation received by email, even outside any project', async () => {
    mocks.groupInvitation.findMany.mockResolvedValue([
      {
        id: 'invitation-1',
        invitedByUserId: 'inviter',
        createdAt: date,
        group: {
          id: 'group-1',
          name: 'Finance',
          project: { id: 'project-1', name: 'Payments' },
        },
      },
    ]);
    mocks.user.findMany.mockResolvedValue([
      { id: 'inviter', name: 'Grace', email: 'grace@cipherion.test' },
    ]);

    const { notifications } = await controller.get({
      ...user,
      email: 'ADA@cipherion.test',
    });

    expect(mocks.groupInvitation.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.groupInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          inviteeEmail: 'ada@cipherion.test',
          status: 'PENDING_ACCEPTANCE',
          group: { deletedAt: null, project: { deletedAt: null } },
        },
      }),
    );
    expect(notifications).toEqual([
      {
        type: 'INVITATION_RECEIVED',
        id: 'invitation-1',
        projectId: 'project-1',
        projectName: 'Payments',
        groupId: 'group-1',
        groupName: 'Finance',
        invitedByName: 'Grace',
        createdAt: date,
      },
    ]);
  });

  it('gives the project admin approvals, and pending lists to group admins', async () => {
    const invitation = (id: string, status: string) => ({
      id,
      groupId: 'group-1',
      inviteeEmail: 'new@cipherion.test',
      status,
      invitedByUserId: 'acting',
      createdAt: date,
    });
    mocks.project.findMany.mockResolvedValue([
      projectRow('project-1', user.id),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'project-1', []),
    ]);
    mocks.groupInvitation.findMany
      .mockResolvedValueOnce([
        invitation('approve-me', 'PENDING_APPROVAL'),
        invitation('waiting', 'PENDING_ACCEPTANCE'),
      ])
      .mockResolvedValueOnce([]);
    mocks.user.findMany.mockResolvedValue([
      { id: 'acting', name: 'Grace', email: 'grace@cipherion.test' },
    ]);

    const { projects, notifications } = await controller.get(user);

    expect(notifications.map(({ type, id }) => [type, id])).toEqual([
      ['INVITATION_APPROVAL', 'approve-me'],
    ]);
    expect(notifications[0]).toMatchObject({
      inviteeEmail: 'new@cipherion.test',
      invitedByName: 'Grace',
    });
    const [group] = projects[0].groups;
    expect(group.pendingInvitations.map(({ id }) => id)).toEqual([
      'approve-me',
      'waiting',
    ]);
    expect(group.pendingInvitations[0].projectId).toBe('project-1');
  });

  it('gives the project admin one device request per project, and missing envelopes', async () => {
    const row = (groupId: string, status: string, deviceId = 'dvc_1') => ({
      groupId,
      status,
      createdAt: date,
      device: { id: deviceId, name: 'Laptop', userId: 'owner' },
    });
    mocks.project.findMany.mockResolvedValue([
      projectRow('project-1', user.id),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'project-1', []),
      groupRow('group-2', 'project-1', []),
    ]);
    mocks.groupDevice.findMany.mockResolvedValue([
      row('group-1', 'PENDING_APPROVAL'),
      row('group-2', 'PENDING_APPROVAL'),
      row('group-1', 'APPROVED', 'dvc_old'),
      row('group-1', 'APPROVED', 'dvc_current'),
    ]);
    mocks.deviceEnvelope.groupBy.mockResolvedValue([
      {
        groupId: 'group-1',
        deviceId: 'dvc_old',
        _max: { envelopeVersion: 2 },
      },
      {
        groupId: 'group-1',
        deviceId: 'dvc_current',
        _max: { envelopeVersion: 3 },
      },
    ]);
    mocks.user.findMany.mockResolvedValue([
      { id: 'owner', name: 'Linus', email: 'linus@cipherion.test' },
    ]);

    const { projects, notifications } = await controller.get(user);

    expect(notifications).toHaveLength(2);
    expect(notifications).toContainEqual({
      type: 'ENVELOPES_MISSING',
      id: 'group-1',
      projectId: 'project-1',
      projectName: 'Payments',
      groupId: 'group-1',
      groupName: 'Finance',
      failureReason: 'INTERRUPTED',
      missingCount: 1,
      createdAt: date,
    });
    expect(notifications).toContainEqual({
      type: 'DEVICE_APPROVAL',
      id: 'dvc_1',
      projectId: 'project-1',
      projectName: 'Payments',
      deviceId: 'dvc_1',
      deviceName: 'Laptop',
      deviceUserName: 'Linus',
      groups: [
        { id: 'group-1', name: 'Finance' },
        { id: 'group-2', name: 'Finance' },
      ],
      createdAt: date,
    });
    expect(projects[0].groups[0].devices).toContainEqual({
      deviceId: 'dvc_current',
      name: 'Laptop',
      userId: 'owner',
      status: 'APPROVED',
      latestEnvelopeVersion: 3,
    });
  });

  describe('envelope job notifications', () => {
    const setUp = (job: Record<string, unknown> | null, missing = true) => {
      mocks.project.findMany.mockResolvedValue([
        projectRow('project-1', user.id),
      ]);
      mocks.group.findMany.mockResolvedValue([
        { ...groupRow('group-1', 'project-1', []), envelopeJob: job },
      ]);
      mocks.groupDevice.findMany.mockResolvedValue([
        {
          groupId: 'group-1',
          status: 'APPROVED',
          createdAt: date,
          reviewedAt: date,
          device: { id: 'dvc_1', name: 'Laptop', userId: 'owner' },
        },
      ]);
      mocks.deviceEnvelope.groupBy.mockResolvedValue([
        {
          groupId: 'group-1',
          deviceId: 'dvc_1',
          _max: { envelopeVersion: missing ? 2 : 3 },
        },
      ]);
    };
    const job = {
      kind: 'ROTATION',
      gdekVersion: 3,
      status: 'RUNNING',
      failureReason: null,
      envelopeCount: 1,
      startedAt: date,
      lastActiveAt: new Date(),
      finishedAt: null,
      dismissedAt: null,
    };
    const notificationsOf = async () =>
      (await controller.get(user)).notifications;

    it('shows a running job as in progress, without asking to resume', async () => {
      setUp(job);

      await expect(notificationsOf()).resolves.toEqual([
        expect.objectContaining({
          type: 'ENVELOPES_IN_PROGRESS',
          jobKind: 'ROTATION',
          missingCount: 1,
          createdAt: date,
        }),
      ]);
    });

    it('asks to resume a job that stopped, with the reason', async () => {
      setUp({ ...job, status: 'FAILED', failureReason: 'KMS_UNAVAILABLE' });

      await expect(notificationsOf()).resolves.toEqual([
        expect.objectContaining({
          type: 'ENVELOPES_MISSING',
          jobKind: 'ROTATION',
          failureReason: 'KMS_UNAVAILABLE',
          missingCount: 1,
        }),
      ]);
    });

    it('treats a running job that stopped updating as interrupted', async () => {
      setUp({ ...job, lastActiveAt: new Date(Date.now() - 3 * 60 * 1000) });

      await expect(notificationsOf()).resolves.toEqual([
        expect.objectContaining({
          type: 'ENVELOPES_MISSING',
          jobKind: 'ROTATION',
          failureReason: 'INTERRUPTED',
        }),
      ]);
    });

    it('treats missing envelopes with no job for this version as interrupted', async () => {
      setUp({ ...job, gdekVersion: 2, status: 'COMPLETED', finishedAt: date });

      const [notification] = await notificationsOf();

      expect(notification).toMatchObject({
        type: 'ENVELOPES_MISSING',
        failureReason: 'INTERRUPTED',
      });
      expect(notification.jobKind).toBeUndefined();
    });

    it('keeps a completed job showing until it is dismissed', async () => {
      const finished = { ...job, status: 'COMPLETED', finishedAt: date };

      setUp(finished, false);
      await expect(notificationsOf()).resolves.toEqual([
        expect.objectContaining({
          type: 'ENVELOPES_COMPLETED',
          jobKind: 'ROTATION',
          envelopeCount: 1,
          createdAt: date,
        }),
      ]);

      setUp({ ...finished, dismissedAt: new Date() }, false);
      await expect(notificationsOf()).resolves.toEqual([]);
    });

    it('never shows a stopped job once nothing is missing', async () => {
      setUp({ ...job, status: 'FAILED', failureReason: 'INTERRUPTED' }, false);

      await expect(notificationsOf()).resolves.toEqual([]);
    });
  });

  it('dates missing envelopes from the rotation or a later approval, not when the device joined', async () => {
    const joined = new Date('2026-01-01T00:00:00.000Z');
    const approvedEarlier = new Date('2026-03-01T00:00:00.000Z');
    const approvedLater = new Date('2026-11-06T00:00:00.000Z');
    const approvedLatest = new Date('2026-11-06T01:00:00.000Z');
    const row = (groupId: string, deviceId: string, reviewedAt: Date) => ({
      groupId,
      status: 'APPROVED',
      createdAt: joined,
      reviewedAt,
      device: { id: deviceId, name: 'Laptop', userId: 'owner' },
    });
    mocks.project.findMany.mockResolvedValue([
      projectRow('project-1', user.id),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('rotated', 'project-1', []),
      groupRow('approved', 'project-1', []),
    ]);
    mocks.groupDevice.findMany.mockResolvedValue([
      row('rotated', 'dvc_1', approvedEarlier),
      row('approved', 'dvc_2', approvedLatest),
      row('approved', 'dvc_3', approvedLater),
    ]);

    const { notifications } = await controller.get(user);

    const missingSince = (groupId: string) =>
      notifications.find((found) => found.groupId === groupId)?.createdAt;
    expect(missingSince('rotated')).toEqual(date);
    expect(missingSince('approved')).toEqual(approvedLater);
  });

  it("lists the user's devices with each group's newest status", async () => {
    mocks.device.findMany.mockResolvedValue([
      {
        id: 'dvc_1',
        name: 'Laptop',
        status: 'ACTIVE',
        createdAt: date,
        groups: [
          {
            groupId: 'group-1',
            status: 'PENDING_APPROVAL',
            group: { name: 'Finance', projectId: 'project-1' },
          },
          {
            groupId: 'group-1',
            status: 'REVOKED',
            group: { name: 'Finance', projectId: 'project-1' },
          },
        ],
      },
    ]);

    const { devices } = await controller.get(user);

    expect(mocks.device.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: user.id } }),
    );
    expect(devices[0].groups).toEqual([
      {
        projectId: 'project-1',
        groupId: 'group-1',
        groupName: 'Finance',
        status: 'PENDING_APPROVAL',
      },
    ]);
  });

  it('gives an acting admin the pending lists but no approvals', async () => {
    mocks.project.findMany.mockResolvedValue([
      projectRow('project-1', 'someone-else'),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'project-1', [
        { userId: user.id, role: 'ACTING_ADMIN', createdAt: date },
      ]),
    ]);
    mocks.groupInvitation.findMany
      .mockResolvedValueOnce([
        {
          id: 'mine',
          groupId: 'group-1',
          inviteeEmail: 'new@cipherion.test',
          status: 'PENDING_APPROVAL',
          invitedByUserId: user.id,
          createdAt: date,
        },
      ])
      .mockResolvedValueOnce([]);

    const { projects, notifications } = await controller.get(user);

    expect(notifications).toEqual([]);
    expect(projects[0].groups[0].pendingInvitations).toHaveLength(1);
  });

  it('asks a plain member for no pending lists', async () => {
    mocks.project.findMany.mockResolvedValue([
      projectRow('project-1', 'someone-else'),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'project-1', [
        { userId: user.id, role: 'MEMBER', createdAt: date },
      ]),
    ]);

    const { projects } = await controller.get(user);

    expect(mocks.groupDevice.findMany).not.toHaveBeenCalled();
    expect(mocks.deviceEnvelope.groupBy).not.toHaveBeenCalled();
    expect(mocks.groupInvitation.findMany).toHaveBeenCalledTimes(1);
    expect(projects[0].groups[0].pendingInvitations).toEqual([]);
    expect(projects[0].groups[0].devices).toEqual([]);
  });

  it('gives a new user default settings and nothing else', async () => {
    await expect(controller.get(user)).resolves.toEqual({
      profile: {
        id: user.id,
        name: 'Ada',
        email: 'ada@cipherion.test',
        emailVerified: true,
        createdAt: date,
      },
      settings: { timezone: 'UTC', locale: 'en', securityAlerts: true },
      projects: [],
      devices: [],
      notifications: [],
    });
    expect(mocks.user.findMany).not.toHaveBeenCalled();
  });

  it('only asks for projects the user belongs to, and for their groups or all if admin', async () => {
    mocks.project.findMany.mockResolvedValue([
      projectRow('admin-project', user.id),
      projectRow('member-project', 'someone-else'),
    ]);

    await controller.get(user);

    expect(mocks.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          OR: [
            { adminUserId: user.id },
            {
              groups: {
                some: {
                  deletedAt: null,
                  members: { some: { userId: user.id } },
                },
              },
            },
          ],
        },
      }),
    );
    expect(mocks.group.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          projectId: { in: ['admin-project', 'member-project'] },
          OR: [
            { projectId: { in: ['admin-project'] } },
            { members: { some: { userId: user.id } } },
          ],
        },
      }),
    );
  });

  it('nests groups and members, with names from the auth database', async () => {
    mocks.project.findMany.mockResolvedValue([
      projectRow('member-project', 'someone-else'),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'member-project', [
        { userId: user.id, role: 'MEMBER', createdAt: date },
        { userId: 'gone', role: 'ADMIN', createdAt: date },
      ]),
    ]);
    mocks.user.findMany.mockResolvedValue([
      { id: user.id, name: 'Ada', email: 'ada@cipherion.test' },
    ]);

    const { projects } = await controller.get(user);

    expect(mocks.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [user.id, 'gone'] } },
      select: { id: true, name: true, email: true },
    });
    expect(projects[0].role).toBe('MEMBER');
    expect(projects[0].keyVersion).toBe(2);
    expect(projects[0].groups[0]).toMatchObject({
      id: 'group-1',
      role: 'MEMBER',
      gdekVersion: 3,
      members: [
        {
          userId: user.id,
          role: 'MEMBER',
          name: 'Ada',
          email: 'ada@cipherion.test',
        },
        { userId: 'gone', role: 'ADMIN', name: null, email: null },
      ],
    });
  });

  it('shows the project admin as admin of every group', async () => {
    mocks.project.findMany.mockResolvedValue([
      projectRow('admin-project', user.id),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'admin-project', []),
    ]);

    const { projects } = await controller.get(user);

    expect(projects[0].groups[0].role).toBe('ADMIN');
  });

  it('never selects wrapped keys or salts', async () => {
    await controller.get(user);

    const selects = JSON.stringify([
      mocks.project.findMany.mock.calls,
      mocks.group.findMany.mock.calls,
      mocks.device.findMany.mock.calls,
      mocks.groupDevice.findMany.mock.calls,
    ]);
    expect(selects).not.toMatch(/wrapped|salt|envelopeJson|publicKey/i);
  });

  it.each(['project', 'userSettings'] as const)(
    'answers 503 when the %s query fails',
    async (model) => {
      const query =
        model === 'project'
          ? mocks.project.findMany
          : mocks.userSettings.findUnique;
      query.mockRejectedValue(new Error('connection refused'));

      await expect(controller.get(user)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );
});
