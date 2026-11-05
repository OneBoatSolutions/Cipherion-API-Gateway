import { ServiceUnavailableException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { WorkspaceController } from './workspace.controller.js';

const mocks = vi.hoisted(() => ({
  project: { findMany: vi.fn() },
  group: { findMany: vi.fn() },
  userSettings: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: { project: mocks.project, group: mocks.group },
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
    mocks.user.findMany.mockResolvedValue([]);
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
