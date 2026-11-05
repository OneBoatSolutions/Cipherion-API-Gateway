import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

interface Workspace {
  profile: { id: string; email: string };
  settings: { timezone: string };
  projects: {
    id: string;
    role: string;
    keyVersion: number | null;
    groups: {
      id: string;
      role: string;
      gdekVersion: number;
      members: { userId: string; name: string; email: string; role: string }[];
    }[];
  }[];
  notifications: unknown[];
}

const wrappedKeys = {
  wrappedGroupRootKeyIv: 'wrapped-iv',
  wrappedGroupRootKey: 'wrapped-key',
  wrappedGroupRootKeyTag: 'wrapped-tag',
  wrappedGroupDataEncryptionKeyIv: 'wrapped-iv',
  wrappedGroupDataEncryptionKey: 'wrapped-key',
  wrappedGroupDataEncryptionKeyTag: 'wrapped-tag',
};

// Runs against the .env.dev databases. The rows are inserted directly, so the
// KMS isn't called. The test users and their CipSeq rows are removed afterwards.
describe('Workspace (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: TestUser;
  let acting: TestUser;
  let member: TestUser;
  let outsideGroups: TestUser;
  let newUser: TestUser;
  const stamp = Date.now();
  const projectId = randomUUID();
  const deletedProjectId = randomUUID();
  const sharedGroupId = randomUUID();
  const hiddenGroupId = randomUUID();
  const deletedGroupId = randomUUID();
  const projectIds = [projectId, deletedProjectId];

  const signUp = async (name: string): Promise<TestUser> => {
    const email = `e2e-workspace-${name}-${stamp}@cipherion.test`;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: {
        origin: trustedOrigins[0],
        'x-forwarded-for': uniqueClientIp(),
      },
      payload: { name: `E2E ${name}`, email, password: 'e2e-password-123' },
    });
    expect(response.statusCode).toBe(200);
    return {
      id: response.json<{ user: { id: string } }>().user.id,
      email,
      cookie: response.cookies
        .map(({ name: key, value }) => `${key}=${value}`)
        .join('; '),
    };
  };

  const workspace = async (user: TestUser): Promise<Workspace> => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: { cookie: user.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/wrapped|salt/i);
    return response.json<Workspace>();
  };

  const createGroup = (
    id: string,
    deletedAt: Date | null,
    members: { userId: string; role: 'ADMIN' | 'MEMBER' }[],
  ) =>
    cipseqPrisma.group.create({
      data: {
        id,
        projectId,
        name: 'Finance',
        description: 'Invoices and payroll',
        deletedAt,
        keys: { create: { ...wrappedKeys, currentGdekVersion: 3 } },
        members: { create: members },
      },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    admin = await signUp('admin');
    acting = await signUp('acting');
    member = await signUp('member');
    outsideGroups = await signUp('outside-groups');
    newUser = await signUp('new');

    const adminRow = { userId: admin.id, role: 'ADMIN' } as const;
    await cipseqPrisma.project.create({
      data: {
        id: projectId,
        name: 'Payments',
        description: 'Card and invoice data',
        adminUserId: admin.id,
        members: {
          create: [admin, acting, member, outsideGroups].map(({ id }) => ({
            userId: id,
          })),
        },
      },
    });
    await cipseqPrisma.project.create({
      data: {
        id: deletedProjectId,
        name: 'Deleted',
        description: 'Deleted',
        adminUserId: admin.id,
        deletedAt: new Date(),
        members: { create: { userId: admin.id } },
      },
    });
    await createGroup(sharedGroupId, null, [
      adminRow,
      { userId: acting.id, role: 'ADMIN' },
      { userId: member.id, role: 'MEMBER' },
    ]);
    await createGroup(hiddenGroupId, null, [adminRow]);
    await createGroup(deletedGroupId, new Date(), [
      adminRow,
      { userId: member.id, role: 'MEMBER' },
    ]);
  });

  afterAll(async () => {
    const where = { projectId: { in: projectIds } };
    const groupWhere = { group: where };
    await cipseqPrisma.$transaction([
      cipseqPrisma.groupMember.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupKeys.deleteMany({ where: groupWhere }),
      cipseqPrisma.group.deleteMany({ where }),
      cipseqPrisma.projectMember.deleteMany({ where }),
      cipseqPrisma.project.deleteMany({ where: { id: { in: projectIds } } }),
    ]);
    for (const user of [admin, acting, member, outsideGroups, newUser]) {
      await deleteTestUser(user.email);
    }
    await app.close();
  });

  const groupIds = (result: Workspace) =>
    result.projects[0].groups.map(({ id }) => id).sort();

  it('needs a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
    });
    expect(response.statusCode).toBe(401);
  });

  it('gives a new user empty projects and default settings', async () => {
    const result = await workspace(newUser);

    expect(result.profile).toMatchObject({
      id: newUser.id,
      email: newUser.email,
    });
    expect(result.settings.timezone).toBe('UTC');
    expect(result.projects).toEqual([]);
    expect(result.notifications).toEqual([]);
  });

  it('shows the project admin every group and leaves out deleted rows', async () => {
    const result = await workspace(admin);

    expect(result.projects.map(({ id }) => id)).toEqual([projectId]);
    expect(result.projects[0].role).toBe('ADMIN');
    expect(groupIds(result)).toEqual([sharedGroupId, hiddenGroupId].sort());
    for (const group of result.projects[0].groups) {
      expect(group.role).toBe('ADMIN');
      expect(group.gdekVersion).toBe(3);
    }
  });

  it('shows an acting admin only their groups', async () => {
    const result = await workspace(acting);

    expect(result.projects[0].role).toBe('MEMBER');
    expect(groupIds(result)).toEqual([sharedGroupId]);
    expect(result.projects[0].groups[0].role).toBe('ADMIN');
  });

  it("shows a member their groups and those groups' members", async () => {
    const result = await workspace(member);

    expect(groupIds(result)).toEqual([sharedGroupId]);
    const [group] = result.projects[0].groups;
    expect(group.role).toBe('MEMBER');
    expect(group.members.map(({ userId }) => userId).sort()).toEqual(
      [admin.id, acting.id, member.id].sort(),
    );
    expect(
      group.members.find(({ userId }) => userId === acting.id),
    ).toMatchObject({
      name: 'E2E acting',
      email: acting.email,
      role: 'ADMIN',
    });
  });

  it('shows a project member outside any group the project but no groups', async () => {
    const result = await workspace(outsideGroups);

    expect(result.projects.map(({ id }) => id)).toEqual([projectId]);
    expect(result.projects[0].groups).toEqual([]);
  });
});
