import { randomBytes, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { FREE_PLAN_DEFAULTS } from './../src/config/free-plan.js';
import { resetMasterCache } from './../src/cipseq/plan-limits.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { type SignedInUser, signUpVerified } from './helpers/users.js';

const PASSPHRASE = 'correct horse battery staple';

interface Limited {
  code: string;
  limit: string;
  max: number;
  message: string;
}

// The free plan at its defaults (setup-e2e.ts lifts it for every other file),
// against the .env.dev databases and the local KMS. Test rows are removed
// afterwards.
describe('Free-plan limits and the master account (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();
  const emails: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];

  let free: SignedInUser;
  let master: SignedInUser;

  const signUp = async (name: string) => {
    const email = `e2e-plan-${name}-${stamp}@cipherion.test`;
    emails.push(email);
    const user = await signUpVerified(app, `E2E ${name}`, email);
    userIds.push(user.id);
    return user;
  };

  const call = (
    user: SignedInUser,
    method: 'GET' | 'POST',
    path: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie: user.cookie },
      payload,
    });

  const expectLimited = (
    response: { statusCode: number; json: <T>() => T; body: string },
    limit: string,
  ) => {
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<Limited>()).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      limit,
    });
  };

  const createProject = async (user: SignedInUser) => {
    const response = await call(user, 'POST', '/cipseq/projects', {
      name: 'Payments',
      description: 'e2e',
    });
    if (response.statusCode === 201) {
      projectIds.push(response.json<{ id: string }>().id);
    }
    return response;
  };

  const initializedProject = async (user: SignedInUser) => {
    const created = await createProject(user);
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: string }>();
    const initialized = await call(
      user,
      'POST',
      `/cipseq/projects/${id}/initialize`,
      { passphrase: PASSPHRASE },
    );
    expect(initialized.statusCode, initialized.body).toBe(200);
    return id;
  };

  const createGroup = (user: SignedInUser, projectId: string) =>
    call(user, 'POST', `/cipseq/projects/${projectId}/groups`, {
      name: 'Finance',
      description: 'e2e',
      passphrase: PASSPHRASE,
    });

  const invite = (
    user: SignedInUser,
    projectId: string,
    groupId: string,
    email: string,
  ) =>
    call(
      user,
      'POST',
      `/cipseq/projects/${projectId}/groups/${groupId}/invitations`,
      {
        email,
      },
    );

  const registerDevice = (user: SignedInUser) =>
    call(user, 'POST', '/cipseq/devices', {
      deviceId: `dvc_${randomBytes(32).toString('base64url')}`,
      publicKey: Buffer.alloc(1568, 7).toString('base64'),
      name: 'e2e device',
    });

  beforeAll(async () => {
    for (const [name, value] of Object.entries(FREE_PLAN_DEFAULTS)) {
      vi.stubEnv(name, String(value));
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    free = await signUp('free');
    master = await signUp('master');
    vi.stubEnv(
      'MASTER_EMAILS',
      `e2e-plan-other-master-${stamp}@cipherion.test, ${master.email}`,
    );
    resetMasterCache();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    resetMasterCache();
    const inProjects = { projectId: { in: projectIds } };
    await cipseqPrisma.$transaction([
      cipseqPrisma.auditEvent.deleteMany({
        where: { OR: [inProjects, { userId: { in: userIds } }] },
      }),
      cipseqPrisma.groupInvitation.deleteMany({ where: { group: inProjects } }),
      cipseqPrisma.groupDevice.deleteMany({
        where: {
          OR: [{ group: inProjects }, { device: { userId: { in: userIds } } }],
        },
      }),
      cipseqPrisma.groupMember.deleteMany({ where: { group: inProjects } }),
      cipseqPrisma.groupKeyVersion.deleteMany({ where: { group: inProjects } }),
      cipseqPrisma.groupKeys.deleteMany({ where: { group: inProjects } }),
      cipseqPrisma.group.deleteMany({ where: inProjects }),
      cipseqPrisma.projectKeyVersion.deleteMany({ where: inProjects }),
      cipseqPrisma.projectKeys.deleteMany({ where: inProjects }),
      cipseqPrisma.project.deleteMany({ where: { id: { in: projectIds } } }),
      cipseqPrisma.device.deleteMany({ where: { userId: { in: userIds } } }),
    ]);
    for (const email of emails) {
      await deleteTestUser(email);
    }
    await app.close();
  });

  describe('a free account', () => {
    let projectId: string;
    let groupId: string;

    it('gets one project', async () => {
      projectId = await initializedProject(free);

      const second = await createProject(free);
      expectLimited(second, 'projects');
      expect(second.json<Limited>()).toMatchObject({
        max: 1,
        message: 'The free plan allows 1 project',
      });
    });

    it('gets two groups per project, without using a passphrase attempt', async () => {
      for (let i = 0; i < 2; i++) {
        const group = await createGroup(free, projectId);
        expect(group.statusCode, group.body).toBe(201);
        groupId ??= group.json<{ id: string }>().id;
      }
      expectLimited(await createGroup(free, projectId), 'groupsPerProject');
    });

    it('gets three people per group, counting open invitations, and a cancel frees a slot', async () => {
      const invitations: string[] = [];
      for (let i = 0; i < 3; i++) {
        const sent = await invite(
          free,
          projectId,
          groupId,
          `e2e-plan-invitee-${i}-${stamp}@cipherion.test`,
        );
        expect(sent.statusCode, sent.body).toBe(201);
        invitations.push(sent.json<{ id: string }>().id);
      }
      expectLimited(
        await invite(
          free,
          projectId,
          groupId,
          `e2e-plan-x-${stamp}@cipherion.test`,
        ),
        'peoplePerGroup',
      );

      const cancelled = await call(
        free,
        'POST',
        `/cipseq/projects/${projectId}/groups/${groupId}/invitations/${invitations[0]}/cancel`,
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const again = await invite(
        free,
        projectId,
        groupId,
        `e2e-plan-again-${stamp}@cipherion.test`,
      );
      expect(again.statusCode, again.body).toBe(201);
    });

    it('refuses to accept into a full group, even an invitation sent before the limit', async () => {
      const invitee = await signUp('invitee');
      // Four open invitations, as a group could have from before this limit.
      const id = randomUUID();
      await cipseqPrisma.groupInvitation.create({
        data: {
          id,
          groupId,
          inviteeEmail: invitee.email,
          invitedByUserId: free.id,
          status: 'PENDING_ACCEPTANCE',
        },
      });

      expectLimited(
        await call(invitee, 'POST', `/cipseq/invitations/${id}/accept`),
        'peoplePerGroup',
      );
      const row = await cipseqPrisma.groupInvitation.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('PENDING_ACCEPTANCE');
    });

    it('gets one active device, and revoking it frees the slot', async () => {
      const first = await registerDevice(free);
      expect(first.statusCode, first.body).toBe(201);
      expectLimited(await registerDevice(free), 'devices');

      const { id } = first.json<{ id: string }>();
      const revoked = await call(free, 'POST', `/cipseq/devices/${id}/revoke`);
      expect(revoked.statusCode, revoked.body).toBe(204);
      expect((await registerDevice(free)).statusCode).toBe(201);
    });

    it('sees its limits and usage in /workspace', async () => {
      const workspace = await call(free, 'GET', '/workspace');
      expect(workspace.statusCode).toBe(200);
      expect(
        workspace.json<{ account: { limits: unknown } }>().account.limits,
      ).toMatchObject({
        master: false,
        projects: { max: 1, used: 1 },
        groupsPerProject: 2,
        peoplePerGroup: 3,
        devices: { max: 1, used: 1 },
        encryptions: { max: 500, used: 0 },
        decryptions: { max: 500, used: 0 },
      });
    });

    it('gets 404 from the master metrics', async () => {
      expect((await call(free, 'GET', '/master/metrics')).statusCode).toBe(404);
    });
  });

  describe('the master account', () => {
    it('goes past every limit', async () => {
      const projectId = await initializedProject(master);
      expect((await createProject(master)).statusCode).toBe(201);

      for (let i = 0; i < 3; i++) {
        expect((await createGroup(master, projectId)).statusCode).toBe(201);
      }
      const group = await createGroup(master, projectId);
      expect(group.statusCode).toBe(201);
      const groupId = group.json<{ id: string }>().id;
      for (let i = 0; i < 4; i++) {
        const sent = await invite(
          master,
          projectId,
          groupId,
          `e2e-plan-m${i}-${stamp}@cipherion.test`,
        );
        expect(sent.statusCode, sent.body).toBe(201);
      }

      expect((await registerDevice(master)).statusCode).toBe(201);
      expect((await registerDevice(master)).statusCode).toBe(201);

      const workspace = await call(master, 'GET', '/workspace');
      expect(
        workspace.json<{ account: { limits: unknown } }>().account.limits,
      ).toMatchObject({
        master: true,
        projects: { max: null, used: 2 },
        groupsPerProject: null,
        peoplePerGroup: null,
        devices: { max: null, used: 2 },
      });
    });

    it('reads the platform metrics, which count what was just created', async () => {
      const response = await call(master, 'GET', '/master/metrics');
      expect(response.statusCode, response.body).toBe(200);
      type Counts = Record<string, number>;
      interface Period {
        start: string;
        end: string;
        totals: Counts;
        series: (Counts & { start: string; end: string })[];
      }
      const { generatedAt, periods } = response.json<{
        generatedAt: string;
        periods: Record<string, Period>;
      }>();
      expect(new Date(generatedAt).getTime()).not.toBeNaN();
      expect(Object.keys(periods)).toEqual(['today', 'week', 'month', 'year']);

      const metrics = [
        'encryptions',
        'decryptions',
        'accountsCreated',
        'accountsDeleted',
        'projectsCreated',
        'projectsDeleted',
        'groupsCreated',
        'groupsDeleted',
        'devicesRegistered',
        'membersRevoked',
        'devicesRevoked',
      ].sort();
      const sizes = { today: 4, week: 7, month: 4, year: 12 };
      for (const [name, period] of Object.entries(periods)) {
        expect(period.series).toHaveLength(sizes[name as keyof typeof sizes]);
        expect(Object.keys(period.totals).sort()).toEqual(metrics);
        expect(period.start).toBe(period.series[0].start);
        expect(period.end).toBe(period.series.at(-1)?.end);
        // Totals are the sum of the buckets.
        for (const metric of metrics) {
          expect(
            period.series.reduce((sum, bucket) => sum + bucket[metric], 0),
          ).toBe(period.totals[metric]);
        }
      }

      // At least what this file created today: 3 accounts, 3 projects,
      // 6 groups, 4 devices and 1 device revoked.
      const today = periods.today.totals;
      expect(today.accountsCreated).toBeGreaterThanOrEqual(3);
      expect(today.projectsCreated).toBeGreaterThanOrEqual(3);
      expect(today.groupsCreated).toBeGreaterThanOrEqual(6);
      expect(today.devicesRegistered).toBeGreaterThanOrEqual(4);
      expect(today.devicesRevoked).toBeGreaterThanOrEqual(1);
      expect(today.accountsDeleted).toBe(0);
      for (const name of ['week', 'month', 'year']) {
        expect(periods[name].totals.projectsCreated).toBeGreaterThanOrEqual(
          today.projectsCreated,
        );
      }
    });
  });
});
