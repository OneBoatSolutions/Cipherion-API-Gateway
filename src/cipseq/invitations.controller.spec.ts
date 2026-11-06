import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { Prisma } from '../generated/cipseq/client.js';
import { InvitationResponsesController } from './invitation-responses.controller.js';
import { InvitationsController } from './invitations.controller.js';

const mocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  project: { findFirst: vi.fn() },
  group: { findFirst: vi.fn() },
  groupMember: { create: vi.fn(), findUnique: vi.fn() },
  projectMember: { upsert: vi.fn() },
  groupInvitation: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  auditEvent: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    $transaction: mocks.$transaction,
    project: mocks.project,
    group: mocks.group,
    groupMember: mocks.groupMember,
    projectMember: mocks.projectMember,
    groupInvitation: mocks.groupInvitation,
    auditEvent: mocks.auditEvent,
  },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: { user: mocks.user } }));

const projectId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const groupId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const id = '3d6f0a51-3f0e-4d3e-9a3a-0f4f6f6d9b11';
const date = new Date('2026-11-05T06:36:46.000Z');
const admin = { id: 'admin-1', email: 'admin@cipherion.test' } as AuthUser;
const acting = { id: 'acting-1', email: 'acting@cipherion.test' } as AuthUser;
const member = { id: 'member-1', email: 'member@cipherion.test' } as AuthUser;
const invitee = { id: 'new-1', email: 'New@cipherion.test' } as AuthUser;

const projectRow = {
  id: projectId,
  name: 'Payments',
  description: 'Card and invoice data',
  adminUserId: admin.id,
  createdAt: date,
  updatedAt: date,
  keys: { currentKeyVersion: 1 },
};

const groupRow = (role: string | null) => ({
  id: groupId,
  projectId,
  name: 'Finance',
  description: 'Invoices and payroll',
  createdAt: date,
  updatedAt: date,
  keys: { currentGdekVersion: 1 },
  members: role ? [{ role }] : [],
});

const invitationRow = (status = 'PENDING_APPROVAL', invitedBy = acting.id) => ({
  id,
  groupId,
  inviteeEmail: 'new@cipherion.test',
  status,
  invitedByUserId: invitedBy,
  createdAt: date,
});

const staleRow = new Prisma.PrismaClientKnownRequestError('stale', {
  code: 'P2025',
  clientVersion: 'test',
});
const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
  code: 'P2002',
  clientVersion: 'test',
});

describe('InvitationsController', () => {
  const controller = new InvitationsController();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    mocks.project.findFirst.mockResolvedValue(projectRow);
    mocks.user.findUnique.mockResolvedValue(null);
    mocks.groupInvitation.findFirst.mockResolvedValue(invitationRow());
  });

  describe('create', () => {
    const create = (user: AuthUser, email = 'NEW@cipherion.test') =>
      controller.create(user, projectId, groupId, { email });

    it("starts the project admin's invitation at PENDING_ACCEPTANCE, lower-cased", async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
      mocks.groupInvitation.create.mockResolvedValue(
        invitationRow('PENDING_ACCEPTANCE', admin.id),
      );

      await expect(create(admin)).resolves.toMatchObject({
        projectId,
        groupId,
        status: 'PENDING_ACCEPTANCE',
      });

      expect(mocks.groupInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            id: expect.any(String),
            groupId,
            inviteeEmail: 'new@cipherion.test',
            invitedByUserId: admin.id,
            status: 'PENDING_ACCEPTANCE',
          },
        }),
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'invitation.created',
          projectId,
          metadata: { groupId, invitationId: expect.any(String) },
        },
      });
      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    });

    it("starts an acting admin's invitation at PENDING_APPROVAL", async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
      mocks.groupInvitation.create.mockResolvedValue(invitationRow());

      await create(acting);

      expect(mocks.groupInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING_APPROVAL' }),
        }),
      );
    });

    it('gives a plain member 403', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('MEMBER'));

      await expect(create(member)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.groupInvitation.create).not.toHaveBeenCalled();
    });

    it('gives a project member outside the group 404', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow(null));

      await expect(create(member)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('gives someone outside the project 404', async () => {
      mocks.project.findFirst.mockResolvedValue(null);

      await expect(create(member)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 409 for someone already in the group', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
      mocks.user.findUnique.mockResolvedValue({ id: 'new-1' });
      mocks.groupMember.findUnique.mockResolvedValue({ userId: 'new-1' });

      await expect(create(admin)).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.groupInvitation.create).not.toHaveBeenCalled();
    });

    it('answers 409 when an invitation is already open', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
      mocks.groupInvitation.create.mockRejectedValue(duplicate);

      await expect(create(admin)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('approve and reject', () => {
    beforeEach(() => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
    });

    it('moves an approved invitation on to the invitee', async () => {
      mocks.groupInvitation.update.mockResolvedValue(
        invitationRow('PENDING_ACCEPTANCE'),
      );

      await controller.approve(admin, projectId, groupId, id);

      expect(mocks.groupInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id, status: 'PENDING_APPROVAL' },
          data: {
            status: 'PENDING_ACCEPTANCE',
            reviewedByUserId: admin.id,
            reviewedAt: expect.any(Date),
          },
        }),
      );
    });

    it('rejects an invitation', async () => {
      mocks.groupInvitation.update.mockResolvedValue(invitationRow('REJECTED'));

      await expect(
        controller.reject(admin, projectId, groupId, id),
      ).resolves.toMatchObject({ status: 'REJECTED' });
    });

    it('only lets the project admin review', async () => {
      await expect(
        controller.approve(acting, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.reject(acting, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('answers 409 when it was already handled', async () => {
      mocks.$transaction.mockRejectedValue(staleRow);

      await expect(
        controller.approve(admin, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 404 for an invitation in another group', async () => {
      mocks.groupInvitation.findFirst.mockResolvedValue(null);

      await expect(
        controller.approve(admin, projectId, groupId, id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.groupInvitation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id, groupId } }),
      );
    });
  });

  describe('cancel', () => {
    it('lets the inviter cancel, even after losing the acting admin role', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('MEMBER'));
      mocks.groupInvitation.update.mockResolvedValue(
        invitationRow('CANCELLED'),
      );

      await expect(
        controller.cancel(acting, projectId, groupId, id),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
    });

    it('lets the project admin cancel anyone’s invitation', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
      mocks.groupInvitation.update.mockResolvedValue(
        invitationRow('CANCELLED'),
      );

      await expect(
        controller.cancel(admin, projectId, groupId, id),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
    });

    it('refuses another member', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));

      await expect(
        controller.cancel(member, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('InvitationResponsesController', () => {
  const controller = new InvitationResponsesController();
  const own = (status = 'PENDING_ACCEPTANCE') => ({
    id,
    groupId,
    status,
    group: { projectId },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    mocks.groupInvitation.findFirst.mockResolvedValue(own());
    mocks.groupInvitation.update.mockResolvedValue(
      invitationRow('ACCEPTED', admin.id),
    );
  });

  it('adds the invitee to the project and the group as a member', async () => {
    await expect(controller.accept(invitee, id)).resolves.toMatchObject({
      projectId,
      status: 'ACCEPTED',
    });

    expect(mocks.groupInvitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id,
          inviteeEmail: 'new@cipherion.test',
          group: { deletedAt: null, project: { deletedAt: null } },
        },
      }),
    );
    expect(mocks.groupInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id, status: 'PENDING_ACCEPTANCE' },
        data: { status: 'ACCEPTED', respondedAt: expect.any(Date) },
      }),
    );
    expect(mocks.projectMember.upsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId, userId: invitee.id } },
      create: { projectId, userId: invitee.id },
      update: {},
    });
    expect(mocks.groupMember.create).toHaveBeenCalledWith({
      data: { groupId, userId: invitee.id, role: 'MEMBER' },
    });
  });

  it('gives anyone else 404', async () => {
    mocks.groupInvitation.findFirst.mockResolvedValue(null);

    await expect(controller.accept(member, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.decline(member, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    'PENDING_APPROVAL',
    'REJECTED',
    'ACCEPTED',
    'DECLINED',
    'CANCELLED',
  ])('refuses an invitation that is %s', async (status) => {
    mocks.groupInvitation.findFirst.mockResolvedValue(own(status));

    await expect(controller.accept(invitee, id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['another response got there first', staleRow],
    ['they are already a member', duplicate],
  ])('answers 409 when %s', async (_name, error) => {
    mocks.$transaction.mockRejectedValue(error);

    await expect(controller.accept(invitee, id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('declines without joining anything', async () => {
    mocks.groupInvitation.update.mockResolvedValue(
      invitationRow('DECLINED', admin.id),
    );

    await expect(controller.decline(invitee, id)).resolves.toMatchObject({
      status: 'DECLINED',
    });
    expect(mocks.groupMember.create).not.toHaveBeenCalled();
    expect(mocks.projectMember.upsert).not.toHaveBeenCalled();
  });
});
