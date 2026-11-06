import { ServiceUnavailableException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { WorkspaceController } from './workspace.controller.js';

const mocks = vi.hoisted(() => ({
  project: { findMany: vi.fn() },
  group: { findMany: vi.fn() },
  groupInvitation: { findMany: vi.fn() },
  groupMemberRemovalRequest: { findMany: vi.fn() },
  userSettings: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    project: mocks.project,
    group: mocks.group,
    groupInvitation: mocks.groupInvitation,
    groupMemberRemovalRequest: mocks.groupMemberRemovalRequest,
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
  keys: { currentGdekVersion: 3 },
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
    mocks.groupMemberRemovalRequest.findMany.mockResolvedValue([]);
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
    const removal = {
      id: 'removal-1',
      groupId: 'group-1',
      targetUserId: 'target',
      status: 'PENDING_APPROVAL',
      requestedByUserId: 'acting',
      createdAt: date,
    };
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
    mocks.groupMemberRemovalRequest.findMany.mockResolvedValue([removal]);
    mocks.user.findMany.mockResolvedValue([
      { id: 'acting', name: 'Grace', email: 'grace@cipherion.test' },
      { id: 'target', name: 'Linus', email: 'linus@cipherion.test' },
    ]);

    const { projects, notifications } = await controller.get(user);

    expect(notifications.map(({ type, id }) => [type, id])).toEqual([
      ['INVITATION_APPROVAL', 'approve-me'],
      ['REMOVAL_APPROVAL', 'removal-1'],
    ]);
    expect(notifications[0]).toMatchObject({
      inviteeEmail: 'new@cipherion.test',
      invitedByName: 'Grace',
    });
    expect(notifications[1]).toMatchObject({
      targetName: 'Linus',
      requestedByName: 'Grace',
    });
    const [group] = projects[0].groups;
    expect(group.pendingInvitations.map(({ id }) => id)).toEqual([
      'approve-me',
      'waiting',
    ]);
    expect(group.pendingInvitations[0].projectId).toBe('project-1');
    expect(group.pendingRemovals[0].projectId).toBe('project-1');
  });

  it('gives an acting admin the pending lists but no approvals', async () => {
    mocks.project.findMany.mockResolvedValue([
      projectRow('project-1', 'someone-else'),
    ]);
    mocks.group.findMany.mockResolvedValue([
      groupRow('group-1', 'project-1', [
        { userId: user.id, role: 'ADMIN', createdAt: date },
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

    expect(mocks.groupMemberRemovalRequest.findMany).not.toHaveBeenCalled();
    expect(mocks.groupInvitation.findMany).toHaveBeenCalledTimes(1);
    expect(projects[0].groups[0].pendingInvitations).toEqual([]);
    expect(projects[0].groups[0].pendingRemovals).toEqual([]);
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
        where: { deletedAt: null, members: { some: { userId: user.id } } },
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
    ]);
    expect(selects).not.toMatch(/wrapped|salt/i);
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
