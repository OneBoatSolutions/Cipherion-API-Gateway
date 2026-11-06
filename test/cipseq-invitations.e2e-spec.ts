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

interface Invitation {
  id: string;
  status: string;
  inviteeEmail: string;
}

interface Notification {
  type: string;
  id: string;
  groupId: string;
  groupName: string;
  projectName: string;
  invitedByName?: string | null;
  inviteeEmail?: string;
  targetName?: string | null;
  requestedByName?: string | null;
}

interface Workspace {
  projects: {
    id: string;
    role: string;
    groups: {
      id: string;
      role: string;
      gdekVersion: number;
      members: { userId: string; role: string }[];
      pendingInvitations: Invitation[];
      pendingRemovals: { id: string; targetUserId: string }[];
    }[];
  }[];
  notifications: Notification[];
}

const PASSPHRASE = 'correct horse battery staple';
const WRONG_PASSPHRASE = 'not the right passphrase';

// Runs against the .env.dev databases and needs the KMS running. The test users
// and their CipSeq rows are removed afterwards.
describe('CipSeq invitations and removal requests (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: TestUser;
  let acting: TestUser;
  let member: TestUser;
  let invitee: TestUser;
  let outsider: TestUser;
  const projectIds: string[] = [];
  const stamp = Date.now();

  const signUp = async (name: string): Promise<TestUser> => {
    const email = `e2e-invite-${name}-${stamp}@cipherion.test`;
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

  const workspace = async (user: TestUser) => {
    const response = await call(user, 'GET', '/workspace');
    expect(response.statusCode).toBe(200);
    return response.json<Workspace>();
  };

  // A project and group owned by the admin. Returns the route prefix.
  const setUp = async () => {
    const created = await call(admin, 'POST', '/cipseq/projects', {
      name: 'Payments',
      description: 'Card and invoice data',
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json<{ id: string }>().id;
    projectIds.push(projectId);
    const initialized = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/initialize`,
      { passphrase: PASSPHRASE },
    );
    expect(initialized.statusCode).toBe(200);
    const group = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      {
        name: 'Finance',
        description: 'Invoices and payroll',
        passphrase: PASSPHRASE,
      },
    );
    expect(group.statusCode).toBe(201);
    const groupId = group.json<{ id: string }>().id;
    return {
      projectId,
      groupId,
      url: `/cipseq/projects/${projectId}/groups/${groupId}`,
    };
  };

  const invite = async (url: string, from: TestUser, to: TestUser) => {
    const response = await call(from, 'POST', `${url}/invitations`, {
      email: to.email,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Invitation>();
  };

  // Joins through the real flow, as a member or an acting admin.
  const join = async (url: string, user: TestUser, role = 'MEMBER') => {
    const invitation = await invite(url, admin, user);
    const accepted = await call(
      user,
      'POST',
      `/cipseq/invitations/${invitation.id}/accept`,
    );
    expect(accepted.statusCode).toBe(200);
    if (role === 'ADMIN') {
      const promoted = await call(admin, 'PATCH', `${url}/members/${user.id}`, {
        role,
      });
      expect(promoted.statusCode).toBe(200);
    }
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
    acting = await signUp('acting');
    member = await signUp('member');
    invitee = await signUp('invitee');
    outsider = await signUp('outsider');
  });

  afterAll(async () => {
    const where = { projectId: { in: projectIds } };
    const groupWhere = { group: where };
    await cipseqPrisma.$transaction([
      cipseqPrisma.groupInvitation.deleteMany({ where: groupWhere }),
      cipseqPrisma.groupMemberRemovalRequest.deleteMany({ where: groupWhere }),
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
    for (const user of [admin, acting, member, invitee, outsider]) {
      await deleteTestUser(user.email);
    }
    await app.close();
  });

  const inviteeNotification = async (invitationId: string) =>
    (await workspace(invitee)).notifications.find(
      ({ id }) => id === invitationId,
    );

  it('lets the admin invite directly, and the invitee see it, accept and join', async () => {
    const { projectId, groupId, url } = await setUp();

    const created = await call(admin, 'POST', `${url}/invitations`, {
      email: invitee.email.toUpperCase(),
    });
    expect(created.statusCode).toBe(201);
    const invitation = created.json<Invitation>();
    expect(invitation).toMatchObject({
      status: 'PENDING_ACCEPTANCE',
      inviteeEmail: invitee.email,
    });

    await expect(inviteeNotification(invitation.id)).resolves.toMatchObject({
      type: 'INVITATION_RECEIVED',
      projectName: 'Payments',
      groupName: 'Finance',
      invitedByName: 'E2E admin',
    });

    // Before accepting they aren't in the project.
    let result = await workspace(invitee);
    expect(result.projects.some(({ id }) => id === projectId)).toBe(false);

    const accepted = await call(
      invitee,
      'POST',
      `/cipseq/invitations/${invitation.id}/accept`,
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<Invitation>().status).toBe('ACCEPTED');

    result = await workspace(invitee);
    const project = result.projects.find(({ id }) => id === projectId);
    expect(project?.role).toBe('MEMBER');
    expect(project?.groups.map(({ id }) => id)).toEqual([groupId]);
    expect(project?.groups[0].gdekVersion).toBe(1);
    expect(project?.groups[0].role).toBe('MEMBER');
    expect(await inviteeNotification(invitation.id)).toBeUndefined();

    const again = await call(
      invitee,
      'POST',
      `/cipseq/invitations/${invitation.id}/accept`,
    );
    expect(again.statusCode).toBe(409);
  });

  it("holds an acting admin's invitation until the project admin approves", async () => {
    const { projectId, url } = await setUp();
    await join(url, acting, 'ADMIN');

    const invitation = await invite(url, acting, invitee);
    expect(invitation.status).toBe('PENDING_APPROVAL');

    // Not visible to the invitee and can't be accepted yet.
    expect(await inviteeNotification(invitation.id)).toBeUndefined();
    const early = await call(
      invitee,
      'POST',
      `/cipseq/invitations/${invitation.id}/accept`,
    );
    expect(early.statusCode).toBe(409);

    const adminView = await workspace(admin);
    expect(
      adminView.notifications.find(({ id }) => id === invitation.id),
    ).toMatchObject({
      type: 'INVITATION_APPROVAL',
      inviteeEmail: invitee.email,
      invitedByName: 'E2E acting',
    });

    const selfApproved = await call(
      acting,
      'POST',
      `${url}/invitations/${invitation.id}/approve`,
    );
    expect(selfApproved.statusCode).toBe(403);

    const approved = await call(
      admin,
      'POST',
      `${url}/invitations/${invitation.id}/approve`,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json<Invitation>().status).toBe('PENDING_ACCEPTANCE');

    const twice = await call(
      admin,
      'POST',
      `${url}/invitations/${invitation.id}/approve`,
    );
    expect(twice.statusCode).toBe(409);

    const accepted = await call(
      invitee,
      'POST',
      `/cipseq/invitations/${invitation.id}/accept`,
    );
    expect(accepted.statusCode).toBe(200);
    const members = await cipseqPrisma.groupMember.count({
      where: { group: { projectId }, userId: invitee.id },
    });
    expect(members).toBe(1);
  });

  it('handles reject, cancel and decline, and allows inviting again', async () => {
    const { url } = await setUp();
    await join(url, acting, 'ADMIN');

    const rejected = await invite(url, acting, invitee);
    const reject = await call(
      admin,
      'POST',
      `${url}/invitations/${rejected.id}/reject`,
    );
    expect(reject.json<Invitation>().status).toBe('REJECTED');

    const cancelled = await invite(url, acting, invitee);
    const cancel = await call(
      acting,
      'POST',
      `${url}/invitations/${cancelled.id}/cancel`,
    );
    expect(cancel.json<Invitation>().status).toBe('CANCELLED');

    const declined = await invite(url, admin, invitee);
    const decline = await call(
      invitee,
      'POST',
      `/cipseq/invitations/${declined.id}/decline`,
    );
    expect(decline.json<Invitation>().status).toBe('DECLINED');

    const open = await invite(url, admin, invitee);
    expect(open.status).toBe('PENDING_ACCEPTANCE');
    const cancelOpen = await call(
      admin,
      'POST',
      `${url}/invitations/${open.id}/cancel`,
    );
    expect(cancelOpen.statusCode).toBe(200);
  });

  it('refuses the wrong person, duplicates and existing members', async () => {
    const { url } = await setUp();
    await join(url, member);
    const invitation = await invite(url, admin, invitee);

    for (const user of [outsider, member, admin]) {
      for (const action of ['accept', 'decline']) {
        const response = await call(
          user,
          'POST',
          `/cipseq/invitations/${invitation.id}/${action}`,
        );
        expect(response.statusCode).toBe(404);
      }
    }

    const duplicate = await call(admin, 'POST', `${url}/invitations`, {
      email: invitee.email,
    });
    expect(duplicate.statusCode).toBe(409);

    const existing = await call(admin, 'POST', `${url}/invitations`, {
      email: member.email,
    });
    expect(existing.statusCode).toBe(409);

    const invalid = await call(admin, 'POST', `${url}/invitations`, {
      email: 'not-an-email',
    });
    expect(invalid.statusCode).toBe(400);

    // An address with no account gets the same answer as any other.
    const noAccount = await call(admin, 'POST', `${url}/invitations`, {
      email: `nobody-${stamp}@cipherion.test`,
    });
    expect(noAccount.statusCode).toBe(201);
  });

  it('applies the access rules to invitations', async () => {
    const { projectId, url } = await setUp();
    await join(url, member);

    // Someone in the project but outside this group can't confirm it exists.
    const other = await call(
      admin,
      'POST',
      `/cipseq/projects/${projectId}/groups`,
      { name: 'Other', description: 'Other', passphrase: PASSPHRASE },
    );
    const otherUrl = `/cipseq/projects/${projectId}/groups/${other.json<{ id: string }>().id}`;

    const email = { email: invitee.email };
    expect(
      (await call(member, 'POST', `${url}/invitations`, email)).statusCode,
    ).toBe(403);
    expect(
      (await call(member, 'POST', `${otherUrl}/invitations`, email)).statusCode,
    ).toBe(404);
    expect(
      (await call(outsider, 'POST', `${url}/invitations`, email)).statusCode,
    ).toBe(404);
  });

  it('removes a member through a request, once the admin approves', async () => {
    const { projectId, groupId, url } = await setUp();
    await join(url, acting, 'ADMIN');
    await join(url, member);

    const created = await call(acting, 'POST', `${url}/removal-requests`, {
      userId: member.id,
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json<{ id: string }>().id;

    const duplicate = await call(acting, 'POST', `${url}/removal-requests`, {
      userId: member.id,
    });
    expect(duplicate.statusCode).toBe(409);

    // The member stays until it's approved.
    await expect(
      cipseqPrisma.groupMember.count({
        where: { groupId, userId: member.id },
      }),
    ).resolves.toBe(1);

    const adminView = await workspace(admin);
    expect(
      adminView.notifications.find(({ id }) => id === requestId),
    ).toMatchObject({
      type: 'REMOVAL_APPROVAL',
      targetName: 'E2E member',
      requestedByName: 'E2E acting',
    });

    const byActing = await call(
      acting,
      'POST',
      `${url}/removal-requests/${requestId}/approve`,
      { passphrase: PASSPHRASE },
    );
    expect(byActing.statusCode).toBe(403);

    const wrong = await call(
      admin,
      'POST',
      `${url}/removal-requests/${requestId}/approve`,
      { passphrase: WRONG_PASSPHRASE },
    );
    expect(wrong.statusCode).toBe(403);
    await expect(
      cipseqPrisma.groupMember.count({
        where: { groupId, userId: member.id },
      }),
    ).resolves.toBe(1);

    const approved = await call(
      admin,
      'POST',
      `${url}/removal-requests/${requestId}/approve`,
      { passphrase: PASSPHRASE },
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ gdekVersion: number }>().gdekVersion).toBe(2);

    await expect(
      cipseqPrisma.groupMember.count({
        where: { groupId, userId: member.id },
      }),
    ).resolves.toBe(0);
    const request =
      await cipseqPrisma.groupMemberRemovalRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
    expect(request.status).toBe('APPROVED');
    expect(request.reviewedByUserId).toBe(admin.id);

    const events = await cipseqPrisma.auditEvent.findMany({
      where: { projectId },
    });
    expect(JSON.stringify(events)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(events)).not.toContain(WRONG_PASSPHRASE);
    expect(events.map(({ action }) => action)).toContain(
      'removal_request.created',
    );

    const twice = await call(
      admin,
      'POST',
      `${url}/removal-requests/${requestId}/approve`,
      { passphrase: PASSPHRASE },
    );
    expect(twice.statusCode).toBe(409);
  });

  it('closes a request by reject, cancel or a direct revoke', async () => {
    const { url } = await setUp();
    await join(url, acting, 'ADMIN');
    await join(url, member);

    const request = async () => {
      const response = await call(acting, 'POST', `${url}/removal-requests`, {
        userId: member.id,
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    };

    const rejected = await call(
      admin,
      'POST',
      `${url}/removal-requests/${await request()}/reject`,
    );
    expect(rejected.json<{ status: string }>().status).toBe('REJECTED');

    const cancelled = await call(
      acting,
      'POST',
      `${url}/removal-requests/${await request()}/cancel`,
    );
    expect(cancelled.json<{ status: string }>().status).toBe('CANCELLED');

    const pending = await request();
    const revoked = await call(
      admin,
      'POST',
      `${url}/members/${member.id}/revoke`,
      { passphrase: PASSPHRASE },
    );
    expect(revoked.statusCode).toBe(200);
    const row = await cipseqPrisma.groupMemberRemovalRequest.findUniqueOrThrow({
      where: { id: pending },
    });
    expect(row.status).toBe('CANCELLED');
  });

  it('refuses invalid removal requests', async () => {
    const { url } = await setUp();
    await join(url, acting, 'ADMIN');
    await join(url, member);
    const body = { userId: member.id };

    expect(
      (await call(admin, 'POST', `${url}/removal-requests`, body)).statusCode,
    ).toBe(400);
    expect(
      (
        await call(member, 'POST', `${url}/removal-requests`, {
          userId: acting.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call(outsider, 'POST', `${url}/removal-requests`, body))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(acting, 'POST', `${url}/removal-requests`, {
          userId: acting.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(acting, 'POST', `${url}/removal-requests`, {
          userId: admin.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(acting, 'POST', `${url}/removal-requests`, {
          userId: 'nobody',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('shows pending lists only to the project admin and acting admins', async () => {
    const { projectId, groupId, url } = await setUp();
    await join(url, acting, 'ADMIN');
    await join(url, member);
    const invitation = await invite(url, acting, invitee);
    const created = await call(acting, 'POST', `${url}/removal-requests`, {
      userId: member.id,
    });
    expect(created.statusCode).toBe(201);

    const groupFor = async (user: TestUser) =>
      (await workspace(user)).projects
        .find(({ id }) => id === projectId)
        ?.groups.find(({ id }) => id === groupId);

    for (const user of [admin, acting]) {
      const group = await groupFor(user);
      expect(group?.pendingInvitations.map(({ id }) => id)).toEqual([
        invitation.id,
      ]);
      expect(group?.pendingRemovals).toHaveLength(1);
    }

    const plain = await groupFor(member);
    expect(plain?.pendingInvitations).toEqual([]);
    expect(plain?.pendingRemovals).toEqual([]);

    // Only the project admin gets the approvals.
    const actingNotifications = (await workspace(acting)).notifications;
    expect(
      actingNotifications.filter(({ groupId: id }) => id === groupId),
    ).toEqual([]);
  });

  it('hides and refuses an invitation to a deleted group', async () => {
    const { url } = await setUp();
    const invitation = await invite(url, admin, invitee);

    const deleted = await call(admin, 'DELETE', url);
    expect(deleted.statusCode).toBe(204);

    expect(await inviteeNotification(invitation.id)).toBeUndefined();
    const accepted = await call(
      invitee,
      'POST',
      `/cipseq/invitations/${invitation.id}/accept`,
    );
    expect(accepted.statusCode).toBe(404);
  });
});
