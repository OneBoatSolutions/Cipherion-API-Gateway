import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { redis } from './../src/lib/redis.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { signUpVerified } from './helpers/users.js';

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

// Runs against the .env.dev databases and needs the KMS running. Other members
// are added directly to the database. The test users and their CipSeq rows are
// removed afterwards.
describe('CipSeq groups (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: TestUser;
  let acting: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  const projectIds: string[] = [];
  const stamp = Date.now();

  const signUp = (name: string): Promise<TestUser> =>
    signUpVerified(
      app,
      `E2E ${name}`,
      `e2e-group-${name}-${stamp}@cipherion.test`,
    );

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

  const addMember = (
    groupId: string,
    userId: string,
    role: 'ACTING_ADMIN' | 'MEMBER' = 'MEMBER',
  ) => cipseqPrisma.groupMember.create({ data: { groupId, userId, role } });

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
      cipseqPrisma.projectKeyVersion.deleteMany({ where }),
      cipseqPrisma.projectKeys.deleteMany({ where }),
      cipseqPrisma.project.deleteMany({ where: { id: { in: projectIds } } }),
    ]);
    for (const user of [admin, acting, member, outsider]) {
      await deleteTestUser(user.email);
    }
    await app.close();
  });

  it('creates at v1, rotates to v2, and revoking changes no keys', async () => {
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

    await addMember(group.id, member.id);
    const revoked = await call(
      admin,
      'POST',
      `${url}/members/${member.id}/revoke`,
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<Group>().gdekVersion).toBe(2);

    const afterRevoke = await storedKeys(group.id);
    expect(afterRevoke.currentGdekVersion).toBe(2);
    expect(afterRevoke.wrappedGroupDataEncryptionKey).toBe(
      v2.wrappedGroupDataEncryptionKey,
    );

    // The version rows record only the number and date.
    const versions = await cipseqPrisma.groupKeyVersion.findMany({
      where: { groupId: group.id },
      orderBy: { gdekVersion: 'asc' },
    });
    expect(versions.map(({ gdekVersion }) => gdekVersion)).toEqual([1, 2]);
    expect(Object.keys(versions[0]).sort()).toEqual([
      'createdAt',
      'gdekVersion',
      'groupId',
    ]);

    await expect(
      cipseqPrisma.groupMember.count({
        where: { groupId: group.id, userId: member.id },
      }),
    ).resolves.toBe(0);

    // They were in only this group, so the project is gone for them too.
    const gone = await call(member, 'GET', `/cipseq/projects/${projectId}`);
    expect(gone.statusCode).toBe(404);

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
    expect(project?.groups[0].gdekVersion).toBe(2);
  });

  it('allows one rotation every 48 hours', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}/rotate`;
    const body = { passphrase: PASSPHRASE };

    // Creating the group doesn't start the 48 hours.
    expect((await call(admin, 'POST', url, body)).statusCode).toBe(200);

    const tooSoon = await call(admin, 'POST', url, body);
    expect(tooSoon.statusCode).toBe(409);
    expect(
      Date.parse(
        tooSoon.json<{ rotationAllowedAt: string }>().rotationAllowedAt,
      ),
    ).toBeGreaterThan(Date.now());

    // A wrong passphrase isn't even checked inside the 48 hours.
    const key = `cipseq:passphrase-attempts:${projectId}`;
    await redis.del(key);
    const wrong = await call(admin, 'POST', url, {
      passphrase: WRONG_PASSPHRASE,
    });
    expect(wrong.statusCode).toBe(409);
    await expect(redis.get(key)).resolves.toBeNull();

    await cipseqPrisma.groupKeyVersion.update({
      where: { groupId_gdekVersion: { groupId: group.id, gdekVersion: 2 } },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000 - 1000) },
    });
    const later = await call(admin, 'POST', url, body);
    expect(later.statusCode).toBe(200);
    expect(later.json<Group>().gdekVersion).toBe(3);
  });

  it('refuses a wrong passphrase with 403 and changes nothing', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;
    const before = await storedKeys(group.id);

    const rotated = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: WRONG_PASSPHRASE,
    });
    expect(rotated.statusCode).toBe(403);
    expect(rotated.json<{ message: string }>().message).toBe(
      'Incorrect passphrase',
    );

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

  it('lets only the project admin change a group', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    await addMember(group.id, acting.id, 'ACTING_ADMIN');
    await addMember(group.id, member.id);
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
      ['PATCH', `${url}/members/${member.id}`, { role: 'ACTING_ADMIN' }],
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
    await addMember(group.id, member.id);

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

  it('sets one acting admin per group and protects the project admin', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${group.id}`;
    await addMember(group.id, member.id);
    await addMember(group.id, acting.id);

    const promoted = await call(admin, 'PATCH', `${url}/members/${member.id}`, {
      role: 'ACTING_ADMIN',
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<{ role: string }>().role).toBe('ACTING_ADMIN');

    const second = await call(admin, 'PATCH', `${url}/members/${acting.id}`, {
      role: 'ACTING_ADMIN',
    });
    expect(second.statusCode).toBe(409);

    // Changing the first back frees the role, and two at once can't both win.
    const demotedFirst = await call(
      admin,
      'PATCH',
      `${url}/members/${member.id}`,
      { role: 'MEMBER' },
    );
    expect(demotedFirst.statusCode).toBe(200);
    const race = await Promise.all(
      [member, acting].map(({ id }) =>
        call(admin, 'PATCH', `${url}/members/${id}`, {
          role: 'ACTING_ADMIN',
        }),
      ),
    );
    expect(
      race.map(({ statusCode }) => statusCode).sort((a, b) => a - b),
    ).toEqual([200, 409]);

    for (const role of ['OWNER', 'ADMIN']) {
      const invalid = await call(
        admin,
        'PATCH',
        `${url}/members/${member.id}`,
        { role },
      );
      expect(invalid.statusCode).toBe(400);
    }

    const demoted = await call(admin, 'PATCH', `${url}/members/${admin.id}`, {
      role: 'MEMBER',
    });
    expect(demoted.statusCode).toBe(400);

    const revoked = await call(
      admin,
      'POST',
      `${url}/members/${admin.id}/revoke`,
    );
    expect(revoked.statusCode).toBe(400);

    const missing = await call(admin, 'PATCH', `${url}/members/nobody`, {
      role: 'MEMBER',
    });
    expect(missing.statusCode).toBe(404);

    const revokeMissing = await call(
      admin,
      'POST',
      `${url}/members/nobody/revoke`,
    );
    expect(revokeMissing.statusCode).toBe(404);
  });

  it('applies the revoke rules to acting admins', async () => {
    const projectId = await createProject();
    const groups = `/cipseq/projects/${projectId}/groups`;
    const first = await createGroup(projectId);
    const second = await createGroup(projectId);
    const url = `${groups}/${first.id}`;
    await addMember(first.id, acting.id, 'ACTING_ADMIN');
    await addMember(first.id, member.id);
    // The other group's acting admin is also a member of the first group.
    await addMember(second.id, outsider.id, 'ACTING_ADMIN');
    await addMember(first.id, outsider.id);

    const revoke = (user: TestUser, userId: string, groupUrl = url) =>
      call(user, 'POST', `${groupUrl}/members/${userId}/revoke`);

    expect((await revoke(acting, admin.id)).statusCode).toBe(400);
    expect((await revoke(acting, acting.id)).statusCode).toBe(400);
    // Only in their own group.
    expect(
      (await revoke(acting, member.id, `${groups}/${second.id}`)).statusCode,
    ).toBe(404);
    expect((await revoke(member, acting.id)).statusCode).toBe(403);

    const revoked = await revoke(acting, member.id);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<Group>().role).toBe('ACTING_ADMIN');

    // Roles are per group: here they're a plain member, and they keep their role
    // in the group they run. Only the project admin can remove them from that one.
    expect((await revoke(acting, outsider.id)).statusCode).toBe(200);
    const stillActing = await cipseqPrisma.groupMember.findUniqueOrThrow({
      where: { groupId_userId: { groupId: second.id, userId: outsider.id } },
    });
    expect(stillActing.role).toBe('ACTING_ADMIN');
    expect(
      (await revoke(admin, outsider.id, `${groups}/${second.id}`)).statusCode,
    ).toBe(200);
  });

  it('removes someone from the whole project', async () => {
    const projectId = await createProject();
    const first = await createGroup(projectId);
    const second = await createGroup(projectId);
    await addMember(first.id, member.id);
    await addMember(second.id, member.id);
    await addMember(first.id, acting.id, 'ACTING_ADMIN');
    const url = `/cipseq/projects/${projectId}/members`;

    expect(
      (await call(acting, 'POST', `${url}/${member.id}/revoke`)).statusCode,
    ).toBe(403);
    expect(
      (await call(admin, 'POST', `${url}/${admin.id}/revoke`)).statusCode,
    ).toBe(400);
    expect((await call(admin, 'POST', `${url}/nobody/revoke`)).statusCode).toBe(
      404,
    );

    const before = await storedKeys(first.id);
    const removed = await call(admin, 'POST', `${url}/${member.id}/revoke`);
    expect(removed.statusCode).toBe(204);

    await expect(
      cipseqPrisma.groupMember.count({
        where: { group: { projectId }, userId: member.id },
      }),
    ).resolves.toBe(0);
    const after = await storedKeys(first.id);
    expect(after.currentGdekVersion).toBe(before.currentGdekVersion);
    const gone = await call(member, 'GET', `/cipseq/projects/${projectId}`);
    expect(gone.statusCode).toBe(404);
  });

  it('keeps a project for its admin, even with no groups left', async () => {
    const projectId = await createProject();
    const group = await createGroup(projectId);
    await addMember(group.id, member.id);
    const url = `/cipseq/projects/${projectId}`;

    const deleted = await call(admin, 'DELETE', `${url}/groups/${group.id}`);
    expect(deleted.statusCode).toBe(204);

    expect((await call(admin, 'GET', url)).statusCode).toBe(200);
    // Their only group is gone, so they aren't a part of the project any more.
    expect((await call(member, 'GET', url)).statusCode).toBe(404);
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
