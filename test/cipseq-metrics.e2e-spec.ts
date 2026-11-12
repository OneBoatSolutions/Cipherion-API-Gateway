import { randomBytes, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { type SignedInUser, signUpVerified } from './helpers/users.js';

interface Totals {
  encryptions: number;
  decryptions: number;
  total: number;
}
interface Bucket extends Totals {
  start: string;
  end: string;
}
interface Window {
  from: string;
  to: string;
  totals: Totals;
  series: Bucket[];
}
interface Leaderboard extends Window {
  period: string;
  projects: (Totals & { projectId: string; name: string })[];
  users: (Totals & { userId: string; name: string | null })[];
  devices: (Totals & { deviceId: string; userId: string })[];
}

const DAY = 24 * 60 * 60 * 1000;

// Projects, groups and devices are created directly: the metrics only read
// envelopeDelivery, so no KMS or certificates are needed here.
describe('CipSeq metrics (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();
  const emails: string[] = [];
  const projectIds: string[] = [];
  const deviceIds: string[] = [];

  // admin: projects P1 and P2. other: P3. many: P4 with 12 devices.
  let admin: SignedInUser;
  let other: SignedInUser;
  let many: SignedInUser;
  let member: SignedInUser;
  let stranger: SignedInUser;
  const ids = {} as Record<
    'p1' | 'p2' | 'p3' | 'p4' | 'g1' | 'g2' | 'g3' | 'g4',
    string
  >;
  let adminDevice: string;
  let memberDevice: string;
  let strangerDevice: string;

  const midnight = new Date(
    new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z',
  );
  const today = new Date(midnight.getTime() + 1000);
  const threeDaysAgo = new Date(midnight.getTime() - 3 * DAY + 3_600_000);
  const fortyDaysAgo = new Date(midnight.getTime() - 40 * DAY);

  const user = async (name: string) => {
    const email = `e2e-metrics-${name}-${stamp}@cipherion.test`;
    emails.push(email);
    return signUpVerified(app, `E2E ${name}`, email);
  };

  const project = async (adminUserId: string, name: string) => {
    const id = randomUUID();
    projectIds.push(id);
    await cipseqPrisma.project.create({
      data: { id, name, description: 'e2e', adminUserId },
    });
    const groupId = randomUUID();
    await cipseqPrisma.group.create({
      data: {
        id: groupId,
        projectId: id,
        name: `${name} group`,
        description: '',
      },
    });
    return { id, groupId };
  };

  const device = async (userId: string) => {
    const id = `dvc_${randomBytes(32).toString('base64url')}`;
    deviceIds.push(id);
    await cipseqPrisma.device.create({
      data: {
        id,
        userId,
        publicKey: 'e2e',
        name: `device ${deviceIds.length}`,
      },
    });
    return id;
  };

  const deliveries = async (
    count: number,
    operation: 'ENCRYPT' | 'DECRYPT',
    at: Date,
    where: {
      userId: string;
      deviceId: string;
      groupId: string;
      projectId: string;
    },
  ) => {
    for (let i = 0; i < count; i++) {
      const requestId = randomUUID();
      const audit = await cipseqPrisma.auditEvent.create({
        data: {
          userId: where.userId,
          action: 'device.envelope_delivered',
          projectId: where.projectId,
          metadata: { requestId, operation },
          createdAt: at,
        },
      });
      await cipseqPrisma.envelopeDelivery.create({
        data: {
          ...where,
          requestId,
          auditEventId: audit.id,
          operation,
          status: 'APPROVED',
          gdekVersion: 1,
          certificateSerial: 'abc123',
          createdAt: at,
        },
      });
    }
  };

  const get = (who: SignedInUser, url: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/cipseq/metrics/${url}`,
      headers: { cookie: who.cookie },
    });
  const leaderboard = async (who: SignedInUser, period?: string) => {
    const response = await get(
      who,
      `leaderboard${period ? `?period=${period}` : ''}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Leaderboard>();
  };
  const usage = (
    who: SignedInUser,
    scope: string,
    id: string,
    period = 'today',
  ) =>
    get(
      who,
      `usage?scope=${scope}&id=${encodeURIComponent(id)}&period=${period}`,
    );

  const counts = ({ encryptions, decryptions, total }: Totals) => [
    encryptions,
    decryptions,
    total,
  ];

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

    admin = await user('admin');
    other = await user('other');
    many = await user('many');
    member = await user('member');
    stranger = await user('stranger');

    const p1 = await project(admin.id, 'P1');
    const p2 = await project(admin.id, 'P2');
    const p3 = await project(other.id, 'P3');
    const p4 = await project(many.id, 'P4');
    Object.assign(ids, {
      p1: p1.id,
      g1: p1.groupId,
      p2: p2.id,
      g2: p2.groupId,
      p3: p3.id,
      g3: p3.groupId,
      p4: p4.id,
      g4: p4.groupId,
    });
    await cipseqPrisma.groupMember.createMany({
      data: [
        { groupId: p1.groupId, userId: member.id, role: 'MEMBER' },
        { groupId: p3.groupId, userId: member.id, role: 'MEMBER' },
      ],
    });

    adminDevice = await device(admin.id);
    memberDevice = await device(member.id);
    strangerDevice = await device(stranger.id);

    const inP1 = {
      userId: member.id,
      deviceId: memberDevice,
      groupId: p1.groupId,
      projectId: p1.id,
    };
    const inP2 = {
      userId: admin.id,
      deviceId: adminDevice,
      groupId: p2.groupId,
      projectId: p2.id,
    };
    const inP3 = {
      userId: member.id,
      deviceId: memberDevice,
      groupId: p3.groupId,
      projectId: p3.id,
    };
    await deliveries(3, 'ENCRYPT', today, inP1);
    await deliveries(1, 'DECRYPT', today, inP1);
    await deliveries(1, 'ENCRYPT', today, inP2);
    await deliveries(2, 'DECRYPT', threeDaysAgo, inP2);
    await deliveries(5, 'ENCRYPT', today, inP3);
    await deliveries(1, 'ENCRYPT', fortyDaysAgo, inP1);

    // 12 devices with 1 to 12 deliveries each, for the top-10 cut-off.
    for (let n = 1; n <= 12; n++) {
      await deliveries(n, 'ENCRYPT', today, {
        userId: many.id,
        deviceId: await device(many.id),
        groupId: p4.groupId,
        projectId: p4.id,
      });
    }
  });

  afterAll(async () => {
    const inProjects = { projectId: { in: projectIds } };
    await cipseqPrisma.envelopeDelivery.deleteMany({ where: inProjects });
    await cipseqPrisma.auditEvent.deleteMany({ where: inProjects });
    await cipseqPrisma.groupMember.deleteMany({
      where: { group: inProjects },
    });
    await cipseqPrisma.group.deleteMany({ where: inProjects });
    await cipseqPrisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    await cipseqPrisma.project.deleteMany({
      where: { id: { in: projectIds } },
    });
    for (const email of emails) {
      await deleteTestUser(email);
    }
    await app.close();
  });

  describe('leaderboard', () => {
    it("ranks only the caller's projects, with their users and devices", async () => {
      const board = await leaderboard(admin, 'today');

      expect(board.projects.map((p) => [p.name, ...counts(p)])).toEqual([
        ['P1', 3, 1, 4],
        ['P2', 1, 0, 1],
      ]);
      // The member's 5 encryptions in another admin's project don't count here.
      expect(board.users.map((u) => [u.userId, ...counts(u)])).toEqual([
        [member.id, 3, 1, 4],
        [admin.id, 1, 0, 1],
      ]);
      expect(board.users[0].name).toBe('E2E member');
      expect(board.devices.map((d) => [d.deviceId, d.userId])).toEqual([
        [memberDevice, member.id],
        [adminDevice, admin.id],
      ]);
      expect(counts(board.totals)).toEqual([4, 1, 5]);
      expect(board.series).toHaveLength(4);
      expect(counts(board.series[0])).toEqual([4, 1, 5]);
    });

    it('filters by period, and defaults to month', async () => {
      const week = await leaderboard(admin, 'week');
      expect(week.projects.map((p) => [p.name, ...counts(p)])).toEqual([
        ['P1', 3, 1, 4],
        ['P2', 1, 2, 3],
      ]);
      expect(week.series).toHaveLength(7);
      expect(counts(week.series[3])).toEqual([0, 2, 2]);
      expect(counts(week.series[6])).toEqual([4, 1, 5]);

      const month = await leaderboard(admin);
      expect(month.period).toBe('month');
      expect(month.series).toHaveLength(30);
      expect(month.totals.total).toBe(7);

      const all = await leaderboard(admin, 'all');
      expect(all.totals.total).toBe(8);
      expect(all.series.length).toBeGreaterThanOrEqual(2);
      expect(all.series.reduce((sum, b) => sum + b.total, 0)).toBe(8);
    });

    it('shows another admin only their own project', async () => {
      const board = await leaderboard(other, 'today');
      expect(board.projects.map((p) => p.name)).toEqual(['P3']);
      expect(board.users.map((u) => [u.userId, u.total])).toEqual([
        [member.id, 5],
      ]);
    });

    it('cuts each list at 10, highest first', async () => {
      const board = await leaderboard(many, 'today');
      expect(board.devices.map((d) => d.total)).toEqual([
        12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
      ]);
      expect(board.totals.total).toBe(78);
    });

    it('is empty for someone who is admin of nothing', async () => {
      const board = await leaderboard(stranger, 'today');
      expect(board).toMatchObject({ projects: [], users: [], devices: [] });
      expect(counts(board.totals)).toEqual([0, 0, 0]);
      expect(board.series.map((b) => b.total)).toEqual([0, 0, 0, 0]);
    });

    it('refuses an unknown period and a missing session', async () => {
      expect((await get(admin, 'leaderboard?period=decade')).statusCode).toBe(
        400,
      );
      const anonymous = await app.inject({
        method: 'GET',
        url: '/api/v1/cipseq/metrics/leaderboard',
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('usage', () => {
    const totalOf = async (
      who: SignedInUser,
      scope: string,
      id: string,
      period = 'today',
    ) => {
      const response = await usage(who, scope, id, period);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<Window & { scope: string; id: string }>();
      expect(body).toMatchObject({ scope, id, period });
      expect(body.series.reduce((sum, b) => sum + b.total, 0)).toBe(
        body.totals.total,
      );
      return counts(body.totals);
    };

    it('counts a project and a group for their admin', async () => {
      expect(await totalOf(admin, 'project', ids.p1)).toEqual([3, 1, 4]);
      expect(await totalOf(admin, 'group', ids.g2, 'week')).toEqual([1, 2, 3]);
      expect(await totalOf(admin, 'project', ids.p1, 'year')).toEqual([
        4, 1, 5,
      ]);
    });

    it('counts everything for yourself and your own device', async () => {
      expect(await totalOf(member, 'user', member.id)).toEqual([8, 1, 9]);
      expect(await totalOf(member, 'device', memberDevice)).toEqual([8, 1, 9]);
    });

    it("counts a member and their device only inside the admin's projects", async () => {
      expect(await totalOf(admin, 'user', member.id)).toEqual([3, 1, 4]);
      expect(await totalOf(admin, 'device', memberDevice)).toEqual([3, 1, 4]);
      expect(await totalOf(other, 'user', member.id)).toEqual([5, 0, 5]);
    });

    it("answers 404 for anything outside the caller's view", async () => {
      const notFound = [
        [admin, 'project', ids.p3],
        [admin, 'group', ids.g3],
        [admin, 'user', stranger.id],
        [admin, 'device', strangerDevice],
        [member, 'project', ids.p1],
        [stranger, 'user', member.id],
        [stranger, 'device', memberDevice],
        [admin, 'project', randomUUID()],
        [admin, 'device', `dvc_${'Z'.repeat(43)}`],
      ] as const;
      for (const [who, scope, id] of notFound) {
        expect((await usage(who, scope, id)).statusCode, `${scope} ${id}`).toBe(
          404,
        );
      }
    });

    it('refuses a bad scope, period or id format', async () => {
      expect((await usage(admin, 'team', ids.p1)).statusCode).toBe(400);
      expect((await usage(admin, 'project', ids.p1, 'all')).statusCode).toBe(
        400,
      );
      const wrongId = await usage(admin, 'device', ids.p1);
      expect(wrongId.statusCode).toBe(400);
      expect(wrongId.json()).toEqual({
        message: 'Validation failed',
        errors: [
          { property: 'id', constraints: ['id must be a device id (dvc_…)'] },
        ],
      });
    });
  });
});
