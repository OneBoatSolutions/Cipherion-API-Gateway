import { randomBytes, randomUUID } from 'node:crypto';
// @ts-expect-error: a plain .mjs script with no type declarations.
import { migrateUserIds } from './../scripts/migrate-user-ids.mjs';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { prisma } from './../src/lib/prisma.js';
import { redis } from './../src/lib/redis.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Seeds one user with an old-style id and rows that point at it in both
// databases, then migrates only that user.
describe('migrate-user-ids (e2e)', () => {
  const oldId = randomBytes(24).toString('base64url').slice(0, 32);
  const other = `other-${randomBytes(8).toString('hex')}`;
  const projectId = randomUUID();
  const groupId = randomUUID();
  const token = randomBytes(16).toString('hex');
  let newId: string;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: oldId,
        name: 'Old id',
        email: `e2e-old-id-${Date.now()}@cipherion.test`,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: oldId,
            providerId: 'credential',
            password: 'not-a-real-hash',
          },
        },
        sessions: {
          create: {
            id: randomUUID(),
            token,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        },
      },
    });
    await redis.set(token, JSON.stringify({ user: { id: oldId } }), 'EX', 600);
    await redis.set(`active-sessions-${oldId}`, '[]', 'EX', 600);
    await cipseqPrisma.project.create({
      data: { id: projectId, name: 'P', description: 'D', adminUserId: oldId },
    });
    await cipseqPrisma.group.create({
      data: { id: groupId, projectId, name: 'G', description: 'D' },
    });
    await cipseqPrisma.groupMember.create({
      data: { groupId, userId: oldId, role: 'ADMIN' },
    });
    await cipseqPrisma.auditEvent.createMany({
      data: [
        { userId: oldId, action: 'project.created', projectId },
        {
          userId: other,
          action: 'project.member_revoked',
          projectId,
          metadata: { targetUserId: oldId },
        },
      ],
    });
  });

  afterAll(async () => {
    await cipseqPrisma.auditEvent.deleteMany({ where: { projectId } });
    await cipseqPrisma.groupMember.deleteMany({ where: { groupId } });
    await cipseqPrisma.group.deleteMany({ where: { id: groupId } });
    await cipseqPrisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: [oldId, newId] } } });
  });

  it('changes nothing on a dry run', async () => {
    await migrateUserIds({ apply: false, onlyUserIds: [oldId] });
    expect(await prisma.user.count({ where: { id: oldId } })).toBe(1);
  });

  it('moves the user and every reference to a UUID v4, and signs them out', async () => {
    await migrateUserIds({ apply: true, onlyUserIds: [oldId] });

    const user = await prisma.user.findFirstOrThrow({
      where: { name: 'Old id', accounts: { some: { providerId: 'credential' } } },
      include: { accounts: true, sessions: true },
      orderBy: { createdAt: 'desc' },
    });
    newId = user.id;
    expect(newId).toMatch(UUID);
    expect(await prisma.user.count({ where: { id: oldId } })).toBe(0);
    expect(user.accounts[0].userId).toBe(newId);
    expect(user.accounts[0].accountId).toBe(newId);
    expect(user.sessions).toEqual([]);
    expect(await redis.exists(token, `active-sessions-${oldId}`)).toBe(0);

    const project = await cipseqPrisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    expect(project.adminUserId).toBe(newId);
    expect(
      await cipseqPrisma.groupMember.count({ where: { groupId, userId: newId } }),
    ).toBe(1);
    const audit = await cipseqPrisma.auditEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit[0].userId).toBe(newId);
    expect(audit[1].userId).toBe(other);
    expect(audit[1].metadata).toEqual({ targetUserId: newId });
  });

  it('does nothing on a second run, and leaves no tracking table behind', async () => {
    const result = await migrateUserIds({ apply: true, onlyUserIds: [oldId] });
    expect(result.migrated).toBe(0);
    const [{ exists }] = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('"_userIdMigration"') IS NOT NULL AS exists`,
    );
    expect(exists).toBe(false);
  });
});
