import { randomBytes } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { TestPki } from './helpers/test-pki.js';
import { signUpVerified } from './helpers/users.js';

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

interface Notification {
  type: string;
  id: string;
  projectId: string;
  deviceId?: string;
  groups?: { id: string }[];
  missingCount?: number;
  groupId?: string;
  jobKind?: string;
  failureReason?: string;
}

interface Workspace {
  projects: {
    id: string;
    groups: {
      id: string;
      devices: {
        deviceId: string;
        status: string;
        latestEnvelopeVersion: number | null;
      }[];
    }[];
  }[];
  devices: { id: string; groups: { groupId: string; status: string }[] }[];
  notifications: Notification[];
}

const PASSPHRASE = 'correct horse battery staple';
const WRONG_PASSPHRASE = 'not the right passphrase';

// Runs against the .env.dev databases and needs the KMS running, with real
// ML-KEM-1024 keys. The test users and their CipSeq rows are removed afterwards.
describe('CipSeq devices (e2e)', () => {
  const pki = new TestPki();
  let app: NestFastifyApplication;
  let admin: TestUser;
  let otherAdmin: TestUser;
  let acting: TestUser;
  let otherActing: TestUser;
  let member: TestUser;
  let loner: TestUser;
  const projectIds: string[] = [];
  const deviceIds: string[] = [];
  const stamp = Date.now();

  const signUp = (name: string): Promise<TestUser> =>
    signUpVerified(
      app,
      `E2E ${name}`,
      `e2e-device-${name}-${stamp}@cipherion.test`,
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

  const workspace = async (user: TestUser) => {
    const response = await call(user, 'GET', '/workspace');
    expect(response.statusCode).toBe(200);
    return response.json<Workspace>();
  };

  const createProject = async (owner = admin) => {
    const created = await call(owner, 'POST', '/cipseq/projects', {
      name: 'Payments',
      description: 'Card and invoice data',
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    projectIds.push(id);
    const initialized = await call(
      owner,
      'POST',
      `/cipseq/projects/${id}/initialize`,
      { passphrase: PASSPHRASE },
    );
    expect(initialized.statusCode).toBe(200);
    return id;
  };

  const createGroup = async (projectId: string, owner = admin) => {
    const response = await call(
      owner,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      {
        name: 'Finance',
        description: 'Invoices and payroll',
        passphrase: PASSPHRASE,
      },
    );
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  };

  const addMember = (
    groupId: string,
    userId: string,
    role: 'ACTING_ADMIN' | 'MEMBER' = 'MEMBER',
  ) => cipseqPrisma.groupMember.create({ data: { groupId, userId, role } });

  // A real key pair, so the KMS wraps for a key it accepts.
  const newDevice = () => {
    const id = `dvc_${randomBytes(32).toString('base64url')}`;
    deviceIds.push(id);
    return { deviceId: id, publicKey: pki.mlKemPublicKey() };
  };

  const register = async (user: TestUser) => {
    const device = newDevice();
    const response = await call(user, 'POST', '/cipseq/devices', device);
    expect(response.statusCode).toBe(201);
    return device;
  };

  const approve = (projectId: string, deviceId: string, owner = admin) =>
    call(
      owner,
      'POST',
      `/cipseq/projects/${projectId}/devices/${deviceId}/approve`,
      {
        passphrase: PASSPHRASE,
      },
    );

  const liveEnvelopes = (deviceId: string, groupId?: string) =>
    cipseqPrisma.deviceEnvelope.findMany({
      where: { deviceId, groupId, deletedAt: null },
      orderBy: { envelopeVersion: 'asc' },
    });

  // The job runs in the background, so poll for what it should have finished.
  const waitForEnvelopes = async (
    deviceId: string,
    groupId: string,
    version: number,
  ) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const envelopes = await liveEnvelopes(deviceId, groupId);
      if (envelopes.some((row) => row.envelopeVersion === version)) {
        return envelopes;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No envelope at version ${version} for ${deviceId}`);
  };

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
    otherAdmin = await signUp('other-admin');
    acting = await signUp('acting');
    otherActing = await signUp('other-acting');
    member = await signUp('member');
    loner = await signUp('loner');
  });

  afterAll(async () => {
    const where = { projectId: { in: projectIds } };
    const groupWhere = { group: where };
    const users = [admin, otherAdmin, acting, otherActing, member, loner];
    await cipseqPrisma.$transaction([
      cipseqPrisma.deviceEnvelope.deleteMany({ where: groupWhere }),
      cipseqPrisma.envelopeJob.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupDevice.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupInvitation.deleteMany({ where: groupWhere }),
      cipseqPrisma.device.deleteMany({
        where: { id: { in: deviceIds } },
      }),
      cipseqPrisma.groupMember.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupKeyVersion.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupKeys.deleteMany({ where: groupWhere }),
      cipseqPrisma.group.deleteMany({ where }),
      cipseqPrisma.auditEvent.deleteMany({
        where: {
          OR: [where, { userId: { in: users.map(({ id }) => id) } }],
        },
      }),
      cipseqPrisma.projectKeyVersion.deleteMany({ where }),
      cipseqPrisma.projectKeys.deleteMany({ where }),
      cipseqPrisma.project.deleteMany({ where: { id: { in: projectIds } } }),
    ]);
    for (const user of users) {
      await deleteTestUser(user.email);
    }
    await app.close();
  });

  it('just registers a device for someone in no groups, and validates input', async () => {
    const device = newDevice();

    const response = await call(loner, 'POST', '/cipseq/devices', {
      ...device,
      name: 'Laptop',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: device.deviceId,
      name: 'Laptop',
      status: 'ACTIVE',
    });
    expect(response.body).not.toContain(device.publicKey);
    await expect(
      cipseqPrisma.groupDevice.count({ where: { deviceId: device.deviceId } }),
    ).resolves.toBe(0);

    // The same registration again changes nothing and answers the same.
    const again = await call(loner, 'POST', '/cipseq/devices', device);
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).toBe(device.deviceId);

    // Someone else, or another key, can't take the id.
    const taken = await call(member, 'POST', '/cipseq/devices', device);
    expect(taken.statusCode).toBe(409);
    const otherKey = await call(loner, 'POST', '/cipseq/devices', {
      ...device,
      publicKey: newDevice().publicKey,
    });
    expect(otherKey.statusCode).toBe(409);

    const badRequests = [
      { ...device, deviceId: 'dvc_short' },
      { ...device, publicKey: Buffer.alloc(1184).toString('base64') },
      { ...device, publicKey: '***' },
      { deviceId: device.deviceId },
    ];
    for (const payload of badRequests) {
      const response = await call(loner, 'POST', '/cipseq/devices', payload);
      expect(response.statusCode).toBe(400);
    }
  });

  it('asks each project admin once, and approving creates envelopes for all waiting groups', async () => {
    const firstProject = await createProject();
    const secondProject = await createProject(otherAdmin);
    const groupA = await createGroup(firstProject);
    const groupB = await createGroup(firstProject);
    const groupC = await createGroup(secondProject, otherAdmin);
    for (const group of [groupA, groupB, groupC]) {
      await addMember(group, member.id);
    }

    const { deviceId, publicKey } = await register(member);

    const requestFor = async (user: TestUser, projectId: string) =>
      (await workspace(user)).notifications.filter(
        (notification) =>
          notification.type === 'DEVICE_APPROVAL' &&
          notification.deviceId === deviceId &&
          notification.projectId === projectId,
      );
    const adminRequests = await requestFor(admin, firstProject);
    expect(adminRequests).toHaveLength(1);
    expect(adminRequests[0].groups?.map(({ id }) => id).sort()).toEqual(
      [groupA, groupB].sort(),
    );
    await expect(requestFor(admin, secondProject)).resolves.toEqual([]);
    await expect(requestFor(otherAdmin, secondProject)).resolves.toHaveLength(
      1,
    );
    await expect(requestFor(member, firstProject)).resolves.toEqual([]);

    // Nothing until approved, and only by that project's admin.
    await expect(liveEnvelopes(deviceId)).resolves.toEqual([]);
    expect((await approve(firstProject, deviceId, member)).statusCode).toBe(
      403,
    );
    expect((await approve(firstProject, deviceId, otherAdmin)).statusCode).toBe(
      404,
    );

    const wrong = await call(
      admin,
      'POST',
      `/cipseq/projects/${firstProject}/devices/${deviceId}/approve`,
      { passphrase: WRONG_PASSPHRASE },
    );
    expect(wrong.statusCode).toBe(403);
    await expect(liveEnvelopes(deviceId)).resolves.toEqual([]);

    const approved = await approve(firstProject, deviceId);
    expect(approved.statusCode).toBe(200);
    expect(
      approved.json<{ envelopesToCreate: number }>().envelopesToCreate,
    ).toBe(1);
    await waitForEnvelopes(deviceId, groupA, 1);
    await waitForEnvelopes(deviceId, groupB, 1);

    // The other project's admin hasn't approved, so it has nothing there.
    await expect(liveEnvelopes(deviceId, groupC)).resolves.toEqual([]);

    // The signed envelope is stored as the KMS returned it, and is valid JSON.
    const [envelope] = await liveEnvelopes(deviceId, groupA);
    expect(() => JSON.parse(envelope.envelopeJson) as unknown).not.toThrow();
    expect(envelope.envelopeVersion).toBe(1);

    const events = await cipseqPrisma.auditEvent.findMany({
      where: { projectId: firstProject },
    });
    expect(events.map(({ action }) => action)).toContain('device.approved');
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(PASSPHRASE);
    expect(serialized).not.toContain(WRONG_PASSPHRASE);
    expect(serialized).not.toContain(publicKey);

    // Workspace shows statuses and versions, never the envelope or wrapped keys.
    const view = await call(admin, 'GET', '/workspace');
    expect(view.body).not.toMatch(/wrapped|salt|envelopeJson/i);
    expect(view.body).not.toContain(envelope.envelopeJson);
  });

  it('sends a new request on joining a group, and approves at the latest version', async () => {
    const projectId = await createProject();
    const first = await createGroup(projectId);
    await addMember(first, member.id);
    const { deviceId } = await register(member);
    expect((await approve(projectId, deviceId)).statusCode).toBe(200);
    await waitForEnvelopes(deviceId, first, 1);

    const second = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${second}`;
    const rotated = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: PASSPHRASE,
    });
    expect(rotated.statusCode).toBe(200);

    const invitation = await call(admin, 'POST', `${url}/invitations`, {
      email: member.email,
    });
    const accepted = await call(
      member,
      'POST',
      `/cipseq/invitations/${invitation.json<{ id: string }>().id}/accept`,
    );
    expect(accepted.statusCode).toBe(200);

    // Filtered by project, because the member is still in earlier tests' groups.
    const requests = (await workspace(admin)).notifications.filter(
      (notification) =>
        notification.type === 'DEVICE_APPROVAL' &&
        notification.deviceId === deviceId &&
        notification.projectId === projectId,
    );
    expect(requests.map(({ groups }) => groups?.map(({ id }) => id))).toEqual([
      [second],
    ]);

    expect((await approve(projectId, deviceId)).statusCode).toBe(200);
    const envelopes = await liveEnvelopes(deviceId, second);
    // It can't read versions from before it was approved.
    expect(envelopes.map(({ envelopeVersion }) => envelopeVersion)).toEqual([
      2,
    ]);
  });

  it("asks for the project admin's own devices on creating a group", async () => {
    const projectId = await createProject(otherAdmin);
    const { deviceId } = await register(otherAdmin);

    const groupId = await createGroup(projectId, otherAdmin);

    const rows = await cipseqPrisma.groupDevice.findMany({
      where: { deviceId, groupId },
    });
    expect(rows.map(({ status }) => status)).toEqual(['PENDING_APPROVAL']);
    expect((await approve(projectId, deviceId, otherAdmin)).statusCode).toBe(
      200,
    );
    await expect(liveEnvelopes(deviceId, groupId)).resolves.toHaveLength(1);
  });

  it('creates new-version envelopes in the background after a rotation, and keeps old ones', async () => {
    const projectId = await createProject();
    const groupId = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${groupId}`;
    await addMember(groupId, member.id);
    const approvedDevice = await register(member);
    const secondDevice = await register(member);
    expect((await approve(projectId, approvedDevice.deviceId)).statusCode).toBe(
      200,
    );
    expect((await approve(projectId, secondDevice.deviceId)).statusCode).toBe(
      200,
    );

    const rotated = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: PASSPHRASE,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({
      gdekVersion: 2,
      envelopesToCreate: 2,
    });

    for (const { deviceId } of [approvedDevice, secondDevice]) {
      const envelopes = await waitForEnvelopes(deviceId, groupId, 2);
      expect(envelopes.map(({ envelopeVersion }) => envelopeVersion)).toEqual([
        1, 2,
      ]);
    }

    const tooSoon = await call(admin, 'POST', `${url}/rotate`, {
      passphrase: PASSPHRASE,
    });
    expect(tooSoon.statusCode).toBe(409);
  });

  it('shows missing envelopes, and renew creates them', async () => {
    const projectId = await createProject();
    const groupId = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${groupId}`;
    await addMember(groupId, member.id);
    const { deviceId } = await register(member);
    expect((await approve(projectId, deviceId)).statusCode).toBe(200);

    // As if a job had stopped: a new version with no envelope for the device.
    await cipseqPrisma.$transaction([
      cipseqPrisma.groupKeyVersion.create({
        data: { groupId, gdekVersion: 2 },
      }),
      cipseqPrisma.groupKeys.update({
        where: { groupId },
        data: { currentGdekVersion: 2 },
      }),
    ]);

    const notification = (await workspace(admin)).notifications.find(
      ({ type, groupId: id }) => type === 'ENVELOPES_MISSING' && id === groupId,
    );
    expect(notification?.missingCount).toBe(1);
    expect(notification?.failureReason).toBe('INTERRUPTED');

    const byMember = await call(member, 'POST', `${url}/envelopes/renew`, {
      passphrase: PASSPHRASE,
    });
    expect(byMember.statusCode).toBe(403);
    const wrong = await call(admin, 'POST', `${url}/envelopes/renew`, {
      passphrase: WRONG_PASSPHRASE,
    });
    expect(wrong.statusCode).toBe(403);

    const renewed = await call(admin, 'POST', `${url}/envelopes/renew`, {
      passphrase: PASSPHRASE,
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toEqual({ envelopesToCreate: 0 });
    await expect(liveEnvelopes(deviceId, groupId)).resolves.toHaveLength(2);

    const after = await workspace(admin);
    expect(
      after.notifications.some(
        ({ type, groupId: id }) =>
          type === 'ENVELOPES_MISSING' && id === groupId,
      ),
    ).toBe(false);

    // Nothing missing: answered without checking the passphrase.
    const nothing = await call(admin, 'POST', `${url}/envelopes/renew`, {
      passphrase: WRONG_PASSPHRASE,
    });
    expect(nothing.json()).toEqual({ envelopesToCreate: 0 });
  });

  it('shows a rotation in progress, asks to resume it if it stops, and keeps the completed notice until dismissed', async () => {
    const projectId = await createProject();
    const groupId = await createGroup(projectId);
    const url = `/cipseq/projects/${projectId}/groups/${groupId}`;
    await addMember(groupId, member.id);
    const { deviceId } = await register(member);
    const second = await register(member);
    expect((await approve(projectId, deviceId)).statusCode).toBe(200);
    expect((await approve(projectId, second.deviceId)).statusCode).toBe(200);
    await waitForEnvelopes(deviceId, groupId, 1);
    await waitForEnvelopes(second.deviceId, groupId, 1);

    const noticeFor = async (type: string) =>
      (await workspace(admin)).notifications.find(
        (found) => found.type === type && found.groupId === groupId,
      );
    const dismiss = () =>
      call(admin, 'POST', `${url}/envelopes/completed/dismiss`);

    expect(
      (await call(admin, 'POST', `${url}/rotate`, { passphrase: PASSPHRASE }))
        .statusCode,
    ).toBe(200);
    await waitForEnvelopes(deviceId, groupId, 2);
    await waitForEnvelopes(second.deviceId, groupId, 2);

    // The job's own write comes just after its last envelope.
    await vi.waitFor(
      async () =>
        expect(await noticeFor('ENVELOPES_COMPLETED')).toMatchObject({
          jobKind: 'ROTATION',
        }),
      { timeout: 5000 },
    );
    // It doesn't go away by itself, only for the project admin, and only once.
    await expect(noticeFor('ENVELOPES_COMPLETED')).resolves.toBeDefined();
    expect(
      (await call(member, 'POST', `${url}/envelopes/completed/dismiss`))
        .statusCode,
    ).toBe(403);
    expect((await dismiss()).statusCode).toBe(204);
    await expect(noticeFor('ENVELOPES_COMPLETED')).resolves.toBeUndefined();
    expect((await dismiss()).statusCode).toBe(204);

    // As if a rotation were running: a new version, and a job updating itself.
    await cipseqPrisma.$transaction([
      cipseqPrisma.groupKeyVersion.create({
        data: { groupId, gdekVersion: 3 },
      }),
      cipseqPrisma.groupKeys.update({
        where: { groupId },
        data: { currentGdekVersion: 3 },
      }),
      cipseqPrisma.envelopeJob.update({
        where: { groupId },
        data: {
          gdekVersion: 3,
          status: 'RUNNING',
          finishedAt: null,
          dismissedAt: null,
          lastActiveAt: new Date(),
        },
      }),
    ]);
    await expect(noticeFor('ENVELOPES_IN_PROGRESS')).resolves.toMatchObject({
      jobKind: 'ROTATION',
      missingCount: 2,
    });
    await expect(noticeFor('ENVELOPES_MISSING')).resolves.toBeUndefined();
    const whileRunning = await call(admin, 'POST', `${url}/envelopes/renew`, {
      passphrase: PASSPHRASE,
    });
    expect(whileRunning.statusCode).toBe(409);

    // As if the gateway died: the row says running, but it stopped updating.
    await cipseqPrisma.envelopeJob.update({
      where: { groupId },
      data: { lastActiveAt: new Date(Date.now() - 3 * 60 * 1000) },
    });
    await expect(noticeFor('ENVELOPES_IN_PROGRESS')).resolves.toBeUndefined();
    await expect(noticeFor('ENVELOPES_MISSING')).resolves.toMatchObject({
      jobKind: 'ROTATION',
      failureReason: 'INTERRUPTED',
      missingCount: 2,
    });

    // Resuming needs the passphrase again, and is still a rotation to the admin.
    expect(
      (
        await call(admin, 'POST', `${url}/envelopes/renew`, {
          passphrase: PASSPHRASE,
        })
      ).statusCode,
    ).toBe(200);
    await waitForEnvelopes(deviceId, groupId, 3);
    await waitForEnvelopes(second.deviceId, groupId, 3);
    await vi.waitFor(
      async () =>
        expect(await noticeFor('ENVELOPES_COMPLETED')).toMatchObject({
          jobKind: 'ROTATION',
        }),
      { timeout: 5000 },
    );
    await expect(noticeFor('ENVELOPES_MISSING')).resolves.toBeUndefined();
  });

  describe('revoking a device', () => {
    // A device approved in two groups of one project and a group of another.
    const setUp = async () => {
      const projectId = await createProject();
      const otherProjectId = await createProject(otherAdmin);
      const groupA = await createGroup(projectId);
      const groupB = await createGroup(projectId);
      const otherGroup = await createGroup(otherProjectId, otherAdmin);
      for (const group of [groupA, groupB, otherGroup]) {
        await addMember(group, member.id);
      }
      await addMember(groupA, acting.id, 'ACTING_ADMIN');
      const { deviceId, publicKey } = await register(member);
      expect((await approve(projectId, deviceId)).statusCode).toBe(200);
      expect(
        (await approve(otherProjectId, deviceId, otherAdmin)).statusCode,
      ).toBe(200);
      await waitForEnvelopes(deviceId, groupA, 1);
      await waitForEnvelopes(deviceId, groupB, 1);
      await waitForEnvelopes(deviceId, otherGroup, 1);
      return {
        projectId,
        otherProjectId,
        groupA,
        groupB,
        otherGroup,
        deviceId,
        publicKey,
        groupUrl: `/cipseq/projects/${projectId}/groups/${groupA}`,
        projectUrl: `/cipseq/projects/${projectId}`,
      };
    };

    it('for one group: only that group, by an acting admin at once, and a rotation skips it', async () => {
      const { groupA, groupB, otherGroup, deviceId, groupUrl } = await setUp();

      const revoked = await call(
        acting,
        'POST',
        `${groupUrl}/devices/${deviceId}/revoke`,
      );
      expect(revoked.statusCode).toBe(204);

      await expect(liveEnvelopes(deviceId, groupA)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, groupB)).resolves.toHaveLength(1);
      await expect(liveEnvelopes(deviceId, otherGroup)).resolves.toHaveLength(
        1,
      );

      // The GDEK version doesn't move.
      const keys = await cipseqPrisma.groupKeys.findUniqueOrThrow({
        where: { groupId: groupA },
      });
      expect(keys.currentGdekVersion).toBe(1);

      // A rotation doesn't bring the envelope back.
      const rotated = await call(admin, 'POST', `${groupUrl}/rotate`, {
        passphrase: PASSPHRASE,
      });
      expect(rotated.json()).toMatchObject({ envelopesToCreate: 0 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(liveEnvelopes(deviceId, groupA)).resolves.toEqual([]);
    });

    it('asks again per group, and approving covers only that group', async () => {
      const { projectUrl, groupA, groupB, deviceId } = await setUp();
      const projectId = projectUrl.split('/').pop() as string;

      expect(
        (await call(admin, 'POST', `${projectUrl}/devices/${deviceId}/revoke`))
          .statusCode,
      ).toBe(204);
      await expect(liveEnvelopes(deviceId, groupA)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, groupB)).resolves.toEqual([]);

      const url = `/cipseq/devices/${deviceId}/groups/${groupA}/request-approval`;
      expect((await call(acting, 'POST', url)).statusCode).toBe(404);
      const requested = await call(member, 'POST', url);
      expect(requested.statusCode).toBe(200);
      expect((await call(member, 'POST', url)).statusCode).toBe(409);

      const approved = await approve(projectId, deviceId);
      expect(approved.statusCode).toBe(200);
      await expect(liveEnvelopes(deviceId, groupA)).resolves.toHaveLength(1);
      await expect(liveEnvelopes(deviceId, groupB)).resolves.toEqual([]);

      // Old soft-deleted rows stay, alongside the new live one.
      await expect(
        cipseqPrisma.deviceEnvelope.count({
          where: { deviceId, groupId: groupA },
        }),
      ).resolves.toBe(2);
    });

    it("for the project: the project admin at once, others' projects untouched", async () => {
      const { groupA, groupB, otherGroup, deviceId, projectUrl } =
        await setUp();

      expect(
        (await call(acting, 'POST', `${projectUrl}/devices/${deviceId}/revoke`))
          .statusCode,
      ).toBe(403);

      const revoked = await call(
        admin,
        'POST',
        `${projectUrl}/devices/${deviceId}/revoke`,
      );
      expect(revoked.statusCode).toBe(204);

      await expect(liveEnvelopes(deviceId, groupA)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, groupB)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, otherGroup)).resolves.toHaveLength(
        1,
      );
    });

    it('for the project: an acting admin has no way to do it', async () => {
      const { groupA, deviceId, projectUrl } = await setUp();

      const revoked = await call(
        acting,
        'POST',
        `${projectUrl}/devices/${deviceId}/revoke`,
      );
      expect(revoked.statusCode).toBe(403);
      const requested = await call(
        acting,
        'POST',
        `${projectUrl}/removal-requests`,
        { deviceId },
      );
      expect(requested.statusCode).toBe(404);

      await expect(liveEnvelopes(deviceId, groupA)).resolves.toHaveLength(1);
    });

    it('everywhere: only its user, permanently', async () => {
      const { groupA, otherGroup, deviceId, publicKey } = await setUp();
      const url = `/cipseq/devices/${deviceId}/revoke`;

      expect((await call(admin, 'POST', url)).statusCode).toBe(404);

      expect((await call(member, 'POST', url)).statusCode).toBe(204);
      await expect(liveEnvelopes(deviceId, groupA)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, otherGroup)).resolves.toEqual([]);

      expect((await call(member, 'POST', url)).statusCode).toBe(409);
      const again = await call(member, 'POST', '/cipseq/devices', {
        deviceId,
        publicKey,
      });
      expect(again.statusCode).toBe(409);
      const requested = await call(
        member,
        'POST',
        `/cipseq/devices/${deviceId}/groups/${groupA}/request-approval`,
      );
      expect(requested.statusCode).toBe(409);

      const view = await workspace(member);
      expect(
        view.devices
          .find(({ id }) => id === deviceId)
          ?.groups.every(({ status }) => status === 'REVOKED'),
      ).toBe(true);
    });

    it("treats another group's acting admin as a plain member of this group", async () => {
      const projectId = await createProject();
      const first = await createGroup(projectId);
      const second = await createGroup(projectId);
      await addMember(first, acting.id, 'ACTING_ADMIN');
      await addMember(second, otherActing.id, 'ACTING_ADMIN');
      await addMember(first, otherActing.id);
      const { deviceId } = await register(otherActing);
      expect((await approve(projectId, deviceId)).statusCode).toBe(200);
      await waitForEnvelopes(deviceId, first, 1);
      await waitForEnvelopes(deviceId, second, 1);
      const url = `/cipseq/projects/${projectId}`;

      // The acting admin of the other group has no power here.
      const backwards = await call(
        otherActing,
        'POST',
        `${url}/groups/${first}/members/${acting.id}/revoke`,
      );
      expect(backwards.statusCode).toBe(403);

      const device = await call(
        acting,
        'POST',
        `${url}/groups/${first}/devices/${deviceId}/revoke`,
      );
      expect(device.statusCode).toBe(204);
      await expect(liveEnvelopes(deviceId, first)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, second)).resolves.toHaveLength(1);

      const removed = await call(
        acting,
        'POST',
        `${url}/groups/${first}/members/${otherActing.id}/revoke`,
      );
      expect(removed.statusCode).toBe(200);

      // Nothing changes in the group they still run.
      const stillActing = await cipseqPrisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: second, userId: otherActing.id } },
      });
      expect(stillActing.role).toBe('ACTING_ADMIN');

      const outsideTheirGroup = await call(
        acting,
        'POST',
        `${url}/groups/${second}/devices/${deviceId}/revoke`,
      );
      expect(outsideTheirGroup.statusCode).toBe(404);
    });
  });

  describe('revoking a member', () => {
    it("from a group soft deletes only that group's envelopes, and keeps the version", async () => {
      const projectId = await createProject();
      const first = await createGroup(projectId);
      const second = await createGroup(projectId);
      await addMember(first, acting.id, 'ACTING_ADMIN');
      await addMember(first, member.id);
      await addMember(second, member.id);
      const { deviceId } = await register(member);
      expect((await approve(projectId, deviceId)).statusCode).toBe(200);
      await waitForEnvelopes(deviceId, first, 1);
      await waitForEnvelopes(deviceId, second, 1);

      const revoked = await call(
        acting,
        'POST',
        `/cipseq/projects/${projectId}/groups/${first}/members/${member.id}/revoke`,
      );
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json<{ gdekVersion: number }>().gdekVersion).toBe(1);

      await expect(liveEnvelopes(deviceId, first)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, second)).resolves.toHaveLength(1);

      // The device is still registered and stays approved for the other group.
      const device = await cipseqPrisma.device.findUniqueOrThrow({
        where: { id: deviceId },
      });
      expect(device.status).toBe('ACTIVE');
    });

    it('from the project removes every envelope there, not elsewhere', async () => {
      const projectId = await createProject();
      const otherProjectId = await createProject(otherAdmin);
      const first = await createGroup(projectId);
      const second = await createGroup(projectId);
      const other = await createGroup(otherProjectId, otherAdmin);
      for (const group of [first, second, other]) {
        await addMember(group, member.id);
      }
      const { deviceId } = await register(member);
      expect((await approve(projectId, deviceId)).statusCode).toBe(200);
      expect(
        (await approve(otherProjectId, deviceId, otherAdmin)).statusCode,
      ).toBe(200);
      await waitForEnvelopes(deviceId, second, 1);
      await waitForEnvelopes(deviceId, first, 1);

      const revoked = await call(
        admin,
        'POST',
        `/cipseq/projects/${projectId}/members/${member.id}/revoke`,
      );
      expect(revoked.statusCode).toBe(204);

      await expect(liveEnvelopes(deviceId, first)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, second)).resolves.toEqual([]);
      await expect(liveEnvelopes(deviceId, other)).resolves.toHaveLength(1);
    });
  });
});
