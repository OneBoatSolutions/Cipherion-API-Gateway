import { ForbiddenException } from '@nestjs/common';
import {
  FREE_PLAN_DEFAULTS,
  type FreePlanVariable,
} from '../config/free-plan.js';
import type { CryptoOperation } from '../generated/cipseq/enums.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';
import { OPEN_INVITATION_STATUSES } from './invitations.dto.js';

// Free-plan limits and the master account. Every limit check goes through here:
// count, then write, in one transaction holding lockPlan(), so two requests in
// parallel can't both take the last slot. Existing data over a limit is kept;
// only new rows are refused.

export type PlanLimit =
  | 'projects'
  | 'groupsPerProject'
  | 'peoplePerGroup'
  | 'devices'
  | 'encryptionsPerMonth'
  | 'decryptionsPerMonth';

const VARIABLES: Record<PlanLimit, FreePlanVariable> = {
  projects: 'FREE_PLAN_MAX_PROJECTS',
  groupsPerProject: 'FREE_PLAN_MAX_GROUPS_PER_PROJECT',
  peoplePerGroup: 'FREE_PLAN_MAX_PEOPLE_PER_GROUP',
  devices: 'FREE_PLAN_MAX_DEVICES',
  encryptionsPerMonth: 'FREE_PLAN_MAX_ENCRYPTIONS_PER_MONTH',
  decryptionsPerMonth: 'FREE_PLAN_MAX_DECRYPTIONS_PER_MONTH',
};

const NOUNS: Record<PlanLimit, [string, string]> = {
  projects: ['project', 'projects'],
  groupsPerProject: ['group per project', 'groups per project'],
  peoplePerGroup: [
    'person per group besides the admin',
    'people per group besides the admin',
  ],
  devices: ['device', 'devices'],
  encryptionsPerMonth: ['encryption a month', 'encryptions a month'],
  decryptionsPerMonth: ['decryption a month', 'decryptions a month'],
};

// Read on each call (ConfigModule doesn't write Joi's defaults back to
// process.env). Joi has already rejected anything that isn't a whole number.
export function freePlanMax(limit: PlanLimit): number {
  const variable = VARIABLES[limit];
  const value = process.env[variable];
  return value === undefined || value === ''
    ? FREE_PLAN_DEFAULTS[variable]
    : Number(value);
}

export const PLAN_LIMIT_REACHED = 'PLAN_LIMIT_REACHED';

export function planLimitReached(
  limit: PlanLimit,
  extra: Record<string, unknown> = {},
): ForbiddenException {
  const max = freePlanMax(limit);
  const [one, many] = NOUNS[limit];
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: PLAN_LIMIT_REACHED,
    limit,
    max,
    message: `The free plan allows ${max} ${max === 1 ? one : many}`,
    ...extra,
  });
}

function assertBelow(limit: PlanLimit, used: number): void {
  if (used >= freePlanMax(limit)) {
    throw planLimitReached(limit);
  }
}

// MASTER_EMAILS: a comma-separated list, matched case-insensitively.
export function masterEmails(): Set<string> {
  return new Set(
    (process.env.MASTER_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Only a verified address counts, so signing up with a master's email before
// its owner does grants nothing.
export function isMaster(user: {
  email: string;
  emailVerified: boolean;
}): boolean {
  return user.emailVerified && masterEmails().has(user.email.toLowerCase());
}

// Ids found to be masters, for the list they were found under. Email changes
// are off, so a master's id can't move to another address. Anyone else is
// looked up again next time, in case they're added or verify later.
let cachedMasters: { list: string; ids: Set<string> } | null = null;

export async function isMasterUserId(userId: string): Promise<boolean> {
  const list = process.env.MASTER_EMAILS ?? '';
  if (masterEmails().size === 0) {
    return false;
  }
  if (cachedMasters?.list !== list) {
    cachedMasters = { list, ids: new Set() };
  }
  if (cachedMasters.ids.has(userId)) {
    return true;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user || !isMaster(user)) {
    return false;
  }
  cachedMasters.ids.add(userId);
  return true;
}

export function resetMasterCache(): void {
  cachedMasters = null;
}

type CipSeqClient = Pick<
  typeof cipseqPrisma,
  | '$executeRaw'
  | 'project'
  | 'group'
  | 'groupMember'
  | 'groupInvitation'
  | 'device'
  | 'envelopeDelivery'
>;

// Held until the transaction ends. $executeRaw, because it returns void.
export const lockPlan = (
  tx: Pick<typeof cipseqPrisma, '$executeRaw'>,
  scope: 'user' | 'project' | 'group' | 'usage',
  id: string,
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan:${scope}:${id}`}::text, 0))`;

const countProjects = (client: CipSeqClient, userId: string) =>
  client.project.count({ where: { adminUserId: userId, deletedAt: null } });

const countGroups = (client: CipSeqClient, projectId: string) =>
  client.group.count({ where: { projectId, deletedAt: null } });

const countDevices = (client: CipSeqClient, userId: string, except?: string) =>
  client.device.count({
    where: {
      userId,
      status: 'ACTIVE',
      ...(except ? { id: { not: except } } : {}),
    },
  });

// Members other than the project admin (an acting admin counts) and open
// invitations. A cancelled, declined or rejected invitation frees its slot.
async function countPeople(
  client: CipSeqClient,
  groupId: string,
  exceptInvitationId?: string,
): Promise<number> {
  const [members, invitations] = await Promise.all([
    client.groupMember.count({
      where: { groupId, role: { not: 'ADMIN' } },
    }),
    client.groupInvitation.count({
      where: {
        groupId,
        status: { in: [...OPEN_INVITATION_STATUSES] },
        ...(exceptInvitationId ? { id: { not: exceptInvitationId } } : {}),
      },
    }),
  ]);
  return members + invitations;
}

// Each assert runs twice: once without `tx` before any KMS call or passphrase
// attempt, so a refusal costs nothing, and again inside the write's
// transaction, under the lock, where it decides.

// The caller's own plan.
export async function assertProjectAllowed(
  user: { id: string; email: string; emailVerified: boolean },
  tx?: CipSeqClient,
): Promise<void> {
  if (isMaster(user)) {
    return;
  }
  if (tx) {
    await lockPlan(tx, 'user', user.id);
  }
  assertBelow('projects', await countProjects(tx ?? cipseqPrisma, user.id));
}

// The project admin's plan, so the master's projects have no limits, even
// for their acting admins.
export async function assertGroupAllowed(
  project: { id: string; adminUserId: string },
  tx?: CipSeqClient,
): Promise<void> {
  if (await isMasterUserId(project.adminUserId)) {
    return;
  }
  if (tx) {
    await lockPlan(tx, 'project', project.id);
  }
  assertBelow(
    'groupsPerProject',
    await countGroups(tx ?? cipseqPrisma, project.id),
  );
}

// For a new invitation, and again when one is accepted (pass its id, so it
// doesn't count against itself). Invitations sent before the limit existed are
// caught on accept.
export async function assertPersonAllowed(
  groupId: string,
  adminUserId: string,
  tx?: CipSeqClient,
  exceptInvitationId?: string,
): Promise<void> {
  if (await isMasterUserId(adminUserId)) {
    return;
  }
  if (tx) {
    await lockPlan(tx, 'group', groupId);
  }
  assertBelow(
    'peoplePerGroup',
    await countPeople(tx ?? cipseqPrisma, groupId, exceptInvitationId),
  );
}

// Active devices only, so revoking one frees its slot. `deviceId` is left out
// of the count, so a retried registration still succeeds.
export async function assertDeviceAllowed(
  user: { id: string; email: string; emailVerified: boolean },
  deviceId: string,
  tx?: CipSeqClient,
): Promise<void> {
  if (isMaster(user)) {
    return;
  }
  if (tx) {
    await lockPlan(tx, 'user', user.id);
  }
  assertBelow(
    'devices',
    await countDevices(tx ?? cipseqPrisma, user.id, deviceId),
  );
}

export const monthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const nextMonthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

const OPERATION_LIMIT: Record<CryptoOperation, PlanLimit> = {
  ENCRYPT: 'encryptionsPerMonth',
  DECRYPT: 'decryptionsPerMonth',
};

// For the engine routes, which return refusals instead of throwing them. The
// quota is the user's own, wherever they encrypt. Counted from envelopeDelivery,
// like the metrics, per calendar month in UTC.
export async function usageRefusal(
  tx: CipSeqClient,
  userId: string,
  operation: CryptoOperation,
  now = new Date(),
): Promise<ForbiddenException | null> {
  await lockPlan(tx, 'usage', userId);
  const used = await tx.envelopeDelivery.count({
    where: { userId, operation, createdAt: { gte: monthStart(now) } },
  });
  const limit = OPERATION_LIMIT[operation];
  return used >= freePlanMax(limit)
    ? planLimitReached(limit, { resetsAt: nextMonthStart(now).toISOString() })
    : null;
}

export interface PlanUsage {
  max: number | null;
  used: number;
}

export interface MonthlyUsage extends PlanUsage {
  resetsAt: Date;
}

export interface PlanLimits {
  master: boolean;
  projects: PlanUsage;
  groupsPerProject: number | null;
  peoplePerGroup: number | null;
  devices: PlanUsage;
  encryptions: MonthlyUsage;
  decryptions: MonthlyUsage;
}

// For GET /workspace. The master sees what it uses, with every max null.
export async function planLimitsFor(
  user: { id: string; email: string; emailVerified: boolean },
  now = new Date(),
): Promise<PlanLimits> {
  const master = isMaster(user);
  const max = (limit: PlanLimit) => (master ? null : freePlanMax(limit));
  const [projects, devices, deliveries] = await Promise.all([
    countProjects(cipseqPrisma, user.id),
    countDevices(cipseqPrisma, user.id),
    cipseqPrisma.envelopeDelivery.groupBy({
      by: ['operation'],
      where: { userId: user.id, createdAt: { gte: monthStart(now) } },
      _count: { _all: true },
    }),
  ]);
  const used = (operation: CryptoOperation) =>
    deliveries.find((row) => row.operation === operation)?._count._all ?? 0;
  const resetsAt = nextMonthStart(now);
  return {
    master,
    projects: { max: max('projects'), used: projects },
    groupsPerProject: max('groupsPerProject'),
    peoplePerGroup: max('peoplePerGroup'),
    devices: { max: max('devices'), used: devices },
    encryptions: {
      max: max('encryptionsPerMonth'),
      used: used('ENCRYPT'),
      resetsAt,
    },
    decryptions: {
      max: max('decryptionsPerMonth'),
      used: used('DECRYPT'),
      resetsAt,
    },
  };
}
