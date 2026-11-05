import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { redis } from './../src/lib/redis.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

interface Group {
  id: string;
  projectId: string;
  name: string;
  description: string;
  role: string;
  gdekVersion: number;
}

const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'a different long passphrase';
const WRONG_PASSPHRASE = 'not the right passphrase';
const GROUP = { name: 'Finance', description: 'Invoices and payroll' };

// Runs against the .env.dev databases and needs the KMS running. Until the
// invitations branch exists, other members are added directly to the database.
// The test users and their CipSeq rows are removed afterwards.
describe('CipSeq groups (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: TestUser;
  let acting: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  const projectIds: string[] = [];
  const stamp = Date.now();

  const signUp = async (name: string): Promise<TestUser> => {
    const email = `e2e-group-${name}-${stamp}@cipherion.test`;
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

  const call = (
    user: TestUser,
    method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie: user.cookie },
      payload,
    });

  const createProject = async (owner = admin, initialise = true) => {
    const created = await call(owner, 'POST', '/cipseq/projects', {
      name: 'Payments',
      description: 'Card and invoice data',
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    projectIds.push(id);
    if (initialise) {
      const response = await call(
        owner,
        'POST',
        `/cipseq/projects/${id}/initialize`,
        { passphrase: PASSPHRASE },
      );
      expect(response.statusCode).toBe(200);
    }
    return id;
  };

  const createGroup = async (projectId: string, owner = admin) => {
    const response = await call(
      owner,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      { ...GROUP, passphrase: PASSPHRASE },
    );
    expect(response.statusCode).toBe(201);
    return response.json<Group>();
  };

  const addMember = async (
    projectId: string,
    groupId: string,
    userId: string,
    role: 'ADMIN' | 'MEMBER' = 'MEMBER',
  ) => {
    await cipseqPrisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId },
      update: {},
    });
    await cipseqPrisma.groupMember.create({ data: { groupId, userId, role } });
  };

  const storedKeys = (groupId: string) =>
    cipseqPrisma.groupKeys.findUniqueOrThrow({ where: { groupId } });

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
    outsider = await signUp('outsider');
  });

  afterAll(async () => {
    const where = { projectId: { in: projectIds } };
    const groupWhere = { group: where };
    await cipseqPrisma.$transaction([
      cipseqPrisma.groupMember.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupKeyVersion.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupKeys.deleteMany({ where: groupWhere }),
      cipseqPrisma.group.deleteMany({ where }),
      cipseqPrisma.auditEvent.deleteMany({ where }),
      cipseqPrisma.projectMember.deleteMany({ where }),
      cipseqPrisma.projectKeyVersion.deleteMany({ where }),
      cipseqPrisma.projectKeys.deleteMany({ where }),
      cipseqPrisma.project.deleteMany({ where: { id: { in: projectIds } } }),
    ]);
    for (const user of [admin, acting, member, outsider]) {
      await deleteTestUser(user.email);
    }
    await app.close();
  });

  it('creates at v1, rotates to v2 and revokes to v3 with a new pair each time', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;
    expect(group).toMatchObject({ ...GROUP, role: 'ADMIN', gdekVersion: 1 });

    const v1 = await storedKeys(group.id);
    expect(v1.currentGdekVersion).toBe(1);

    const rotated = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: PASSPHRASE,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json<Group>().gdekVersion).toBe(2);

    const v2 = await storedKeys(group.id);
    expect(v2.currentGdekVersion).toBe(2);
    expect(v2.wrappedGroupRootKey).not.toBe(v1.wrappedGroupRootKey);
    expect(v2.wrappedGroupDataEncryptionKey).not.toBe(
      v1.wrappedGroupDataEncryptionKey,
    );

    await addMember(projectId, group.id, member.id);
    const revoked = await call(
      admin,
      'POST',
      `${url}/members/${member.id}/revoke`,
      { passphrase: PASSPHRASE },
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<Group>().gdekVersion).toBe(3);

    const v3 = await storedKeys(group.id);
    expect(v3.currentGdekVersion).toBe(3);
    expect(v3.wrappedGroupDataEncryptionKey).not.toBe(
      v2.wrappedGroupDataEncryptionKey,
    );

    // The version rows record only the number and date.
    const versions = await cipseqPrisma.groupKeyVersion.findMany({
      where: { groupId: group.id },
      orderBy: { gdekVersion: 'asc' },
    });
    expect(versions.map(({ gdekVersion }) => gdekVersion)).toEqual([1, 2, 3]);
    expect(Object.keys(versions[0]).sort()).toEqual([
      'createdAt',
      'gdekVersion',
      'groupId',
    ]);

    // Revoked from the group only: they stay in the project.
    await expect(
      cipseqPrisma.groupMember.count({
        where: { groupId: group.id, userId: member.id },
      }),
    ).resolves.toBe(0);
    await expect(
      cipseqPrisma.projectMember.count({
        where: { projectId, userId: member.id },
      }),
    ).resolves.toBe(1);

    const events = await cipseqPrisma.auditEvent.findMany({
      where: { projectId, action: { startsWith: 'group.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map(({ action }) => action)).toEqual([
      'group.created',
      'group.key_rotated',
      'group.member_revoked',
    ]);
    expect(JSON.stringify(events)).not.toContain(PASSPHRASE);

    // Responses and the workspace carry versions but never key material.
    for (const body of [rotated.body, revoked.body]) {
      expect(body).not.toMatch(/wrapped|salt/i);
    }
    const workspace = await call(admin, 'GET', '/workspace');
    expect(workspace.body).not.toMatch(/wrapped|salt/i);
    const project = workspace
      .json<{ projects: { id: string; groups: Group[] }[] }>()
      .projects.find(({ id }) => id === projectId);
    expect(project?.groups[0].gdekVersion).toBe(3);
  });

  it('refuses a wrong passphrase with 403 and changes nothing', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;
    await addMember(projectId, group.id, member.id);
    const before = await storedKeys(group.id);

    const rotated = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: WRONG_PASSPHRASE,
    });
    expect(rotated.statusCode).toBe(403);
    expect(rotated.json<{ message: string }>().message).toBe(
      'Incorrect passphrase',
    );

    const revoked = await call(
      admin,
      'POST',
      `${url}/members/${member.id}/revoke`,
      { passphrase: WRONG_PASSPHRASE },
    );
    expect(revoked.statusCode).toBe(403);

    const created = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      { ...GROUP, passphrase: WRONG_PASSPHRASE },
    );
    expect(created.statusCode).toBe(403);

    const after = await storedKeys(group.id);
    expect(after.currentGdekVersion).toBe(1);
    expect(after.wrappedGroupDataEncryptionKey).toBe(
      before.wrappedGroupDataEncryptionKey,
    );
    await expect(
      cipseqPrisma.groupMember.count({
        where: { groupId: group.id, userId: member.id },
      }),
    ).resolves.toBe(1);
    await expect(
      cipseqPrisma.group.count({ where: { projectId } }),
    ).resolves.toBe(1);
  });

  it('keeps working with the new passphrase after a project passphrase change', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;

    const changed = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/rotate`,
      { currentPassphrase: PASSPHRASE, newPassphrase: NEW_PASSPHRASE },
    );
    expect(changed.statusCode).toBe(200);

    const old = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: PASSPHRASE,
    });
    expect(old.statusCode).toBe(403);

    const rotated = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: NEW_PASSPHRASE,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json<Group>().gdekVersion).toBe(2);
  });

  it('shares the project attempt limit across group calls', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}/rotate`;
    const key = `cipseq:passphrase-attempts:${projectId}`;

    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await call(admin, 'POST', url, {
          passphrase: WRONG_PASSPHRASE,
        });
        expect(response.statusCode).toBe(403);
      }

      const correct = await call(admin, 'POST', url, {
        passphrase: PASSPHRASE,
      });
      expect(correct.statusCode).toBe(429);

      const project = await call(
        admin,
        'POST',
        `/cipseq/projects/${projectId}/rotate`,
        { currentPassphrase: PASSPHRASE, newPassphrase: NEW_PASSPHRASE },
      );
      expect(project.statusCode).toBe(429);
    } finally {
      await redis.del(key);
    }
  });

  it('lets only the project admin write', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    await addMember(projectId, group.id, acting.id, 'ADMIN');
    await addMember(projectId, group.id, member.id);
    const groups = `/cipseq/projects/${projectId}/groups`;
    const url = `${groups}/${group.id}`;
    const passphrase = { passphrase: PASSPHRASE };

    const attempts: [
      'POST' | 'PATCH' | 'DELETE',
      string,
      object | undefined,
    ][] = [
      ['POST', groups, { ...GROUP, ...passphrase }],
      ['PATCH', url, { name: 'Accounts' }],
      ['POST', `${url}/rotate`, passphrase],
      ['PATCH', `${url}/members/${member.id}`, { role: 'ADMIN' }],
      ['POST', `${url}/members/${member.id}/revoke`, passphrase],
      ['DELETE', url, undefined],
    ];

    for (const [method, path, payload] of attempts) {
      for (const user of [acting, member]) {
        const response = await call(user, method, path, payload);
        expect(response.statusCode).toBe(403);
      }
      const response = await call(outsider, method, path, payload);
      expect(response.statusCode).toBe(404);
    }

    const after = await storedKeys(group.id);
    expect(after.currentGdekVersion).toBe(1);
  });

  it('lets a user change only the project they are the admin of', async () => {
    const theirs = await createProject(member);
    const someoneElses = await createProject();
    const group = await createGroup(someoneElses);
    await addMember(someoneElses, group.id, member.id);

    const own = await call(
      member,
      'POST',
      `/cipseq/projects/${theirs}/groups`,
      { ...GROUP, passphrase: PASSPHRASE },
    );
    expect(own.statusCode).toBe(201);

    const other = await call(
      member,
      'POST',
      `/cipseq/projects/${someoneElses}/groups`,
      { ...GROUP, passphrase: PASSPHRASE },
    );
    expect(other.statusCode).toBe(403);
  });

  it('sets acting admins and protects the project admin', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;
    await addMember(projectId, group.id, member.id);

    const promoted = await call(admin, 'PATCH', `${url}/members/${member.id}`, {
      role: 'ADMIN',
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<{ role: string }>().role).toBe('ADMIN');

    const invalid = await call(admin, 'PATCH', `${url}/members/${member.id}`, {
      role: 'OWNER',
    });
    expect(invalid.statusCode).toBe(400);

    const demoted = await call(admin, 'PATCH', `${url}/members/${admin.id}`, {
      role: 'MEMBER',
    });
    expect(demoted.statusCode).toBe(400);

    const revoked = await call(
      admin,
      'POST',
      `${url}/members/${admin.id}/revoke`,
      { passphrase: PASSPHRASE },
    );
    expect(revoked.statusCode).toBe(400);

    const missing = await call(admin, 'PATCH', `${url}/members/nobody`, {
      role: 'ADMIN',
    });
    expect(missing.statusCode).toBe(404);

    const revokeMissing = await call(
      admin,
      'POST',
      `${url}/members/nobody/revoke`,
      { passphrase: PASSPHRASE },
    );
    expect(revokeMissing.statusCode).toBe(404);
  });

  it('updates, validates and soft deletes a group', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;

    const updated = await call(admin, 'PATCH', url, {
      description: 'Only payroll',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<Group>()).toMatchObject({
      name: GROUP.name,
      description: 'Only payroll',
    });

    const nulled = await call(admin, 'PATCH', url, { name: null });
    expect(nulled.statusCode).toBe(400);

    const missingDescription = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      { name: 'Finance', passphrase: PASSPHRASE },
    );
    expect(missingDescription.statusCode).toBe(400);

    const deleted = await call(admin, 'DELETE', url);
    expect(deleted.statusCode).toBe(204);

    const row = await cipseqPrisma.group.findUniqueOrThrow({
      where: { id: group.id },
    });
    expect(row.deletedAt).not.toBeNull();

    const afterDelete = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: PASSPHRASE,
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('needs an initialised project', async () => {
    const projectId = await createProject(admin, false);

    const response = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      { ...GROUP, passphrase: PASSPHRASE },
    );
    expect(response.statusCode).toBe(409);
  });
});
