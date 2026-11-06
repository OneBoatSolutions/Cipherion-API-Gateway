import { ServiceUnavailableException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { IncorrectPassphraseException } from '../kms/incorrect-passphrase.exception.js';
import {
  countMissingEnvelopes,
  createFirstMissingEnvelope,
  removeIneligibleEnvelopes,
  startEnvelopeJob,
  wrapEnvelope,
} from './device-envelopes.js';

const mocks = vi.hoisted(() => ({
  kmsCall: vi.fn(),
  $transaction: vi.fn(),
  projectKeys: { findUniqueOrThrow: vi.fn() },
  groupKeys: { findFirst: vi.fn(), findMany: vi.fn() },
  groupDevice: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  deviceEnvelope: { createMany: vi.fn(), updateMany: vi.fn() },
  envelopeJob: { upsert: vi.fn(), updateMany: vi.fn() },
  auditEvent: { create: vi.fn() },
}));

vi.mock('../kms/kms-call.js', () => ({ kmsCall: mocks.kmsCall }));
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    $transaction: mocks.$transaction,
    projectKeys: mocks.projectKeys,
    groupKeys: mocks.groupKeys,
    groupDevice: mocks.groupDevice,
    deviceEnvelope: mocks.deviceEnvelope,
    envelopeJob: mocks.envelopeJob,
    auditEvent: mocks.auditEvent,
  },
}));

const PASSPHRASE = 'correct horse battery staple';
const projectId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const groupId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const actor = 'admin-1';

const projectKeys = {
  projectId,
  wrappedProjectRootKeyIv: 'root-iv',
  wrappedProjectRootKey: 'root-key',
  wrappedProjectRootKeyTag: 'root-tag',
  wrappedProjectEncryptionKeyIv: 'enc-iv',
  wrappedProjectEncryptionKey: 'enc-key',
  wrappedProjectEncryptionKeyTag: 'enc-tag',
  userPassphraseSalt: 'salt',
};

const groupKeys = (currentGdekVersion = 2) => ({
  groupId,
  wrappedGroupRootKeyIv: 'grk-iv',
  wrappedGroupRootKey: 'grk',
  wrappedGroupRootKeyTag: 'grk-tag',
  wrappedGroupDataEncryptionKeyIv: 'gdek-iv',
  wrappedGroupDataEncryptionKey: 'gdek',
  wrappedGroupDataEncryptionKeyTag: 'gdek-tag',
  currentGdekVersion,
});

const row = (id: string) => ({
  id: `row-${id}`,
  device: { id, publicKey: `key-${id}` },
});

// The job isn't awaited by its caller, so wait for what it's expected to finish on.
const jobFinished = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('device envelopes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    mocks.projectKeys.findUniqueOrThrow.mockResolvedValue(projectKeys);
    mocks.groupKeys.findFirst.mockResolvedValue(groupKeys());
    mocks.kmsCall.mockImplementation((_method, request: { DeviceId: string }) =>
      Promise.resolve({ EnvelopeJson: `{"device":"${request.DeviceId}"}` }),
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('wrapEnvelope', () => {
    it('asks the KMS for an ML-KEM-1024 envelope at the current version', async () => {
      await expect(
        wrapEnvelope(
          projectId,
          groupId,
          { id: 'dvc_1', publicKey: 'key-1' },
          PASSPHRASE,
        ),
      ).resolves.toEqual({
        groupId,
        deviceId: 'dvc_1',
        envelopeVersion: 2,
        envelopeJson: '{"device":"dvc_1"}',
      });

      expect(mocks.kmsCall).toHaveBeenCalledWith('createDeviceEnvelope', {
        Suite: 2,
        ProjectId: projectId,
        GroupId: groupId,
        DeviceId: 'dvc_1',
        GdekVersion: 2,
        DeviceEncapsulationKey: 'key-1',
        WrappedProjectRootKeyIV: 'root-iv',
        WrappedProjectRootKey: 'root-key',
        WrappedProjectRootKeyTag: 'root-tag',
        WrappedProjectEncryptionKeyIV: 'enc-iv',
        WrappedProjectEncryptionKey: 'enc-key',
        WrappedProjectEncryptionKeyTag: 'enc-tag',
        WrappedGroupRootKeyIV: 'grk-iv',
        WrappedGroupRootKey: 'grk',
        WrappedGroupRootKeyTag: 'grk-tag',
        WrappedGroupDataEncryptionKeyIV: 'gdek-iv',
        WrappedGroupDataEncryptionKey: 'gdek',
        WrappedGroupDataEncryptionKeyTag: 'gdek-tag',
        UserPassphrase: PASSPHRASE,
        UserPassphraseSalt: 'salt',
      });
    });
  });

  describe('removeIneligibleEnvelopes', () => {
    it('soft deletes unless the device is active and approved for the group', async () => {
      await removeIneligibleEnvelopes(groupId, ['dvc_1']);

      expect(mocks.deviceEnvelope.updateMany).toHaveBeenCalledWith({
        where: {
          groupId,
          deviceId: { in: ['dvc_1'] },
          deletedAt: null,
          NOT: {
            device: {
              status: 'ACTIVE',
              groups: { some: { groupId, status: 'APPROVED' } },
            },
          },
        },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  describe('createFirstMissingEnvelope', () => {
    it('makes no KMS call when nothing is missing', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue(null);

      await expect(
        createFirstMissingEnvelope(actor, projectId, groupId, PASSPHRASE),
      ).resolves.toBe(false);
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('lets a wrong passphrase reach the caller and commits nothing', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue(row('dvc_1'));
      mocks.kmsCall.mockRejectedValue(new IncorrectPassphraseException());

      await expect(
        createFirstMissingEnvelope(actor, projectId, groupId, PASSPHRASE),
      ).rejects.toBeInstanceOf(IncorrectPassphraseException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('commits the envelope, then checks it is still allowed', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue(row('dvc_1'));

      await expect(
        createFirstMissingEnvelope(actor, projectId, groupId, PASSPHRASE),
      ).resolves.toBe(true);

      expect(mocks.deviceEnvelope.createMany).toHaveBeenCalledWith({
        data: [
          {
            groupId,
            deviceId: 'dvc_1',
            envelopeVersion: 2,
            envelopeJson: '{"device":"dvc_1"}',
          },
        ],
        skipDuplicates: true,
      });
      expect(mocks.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.deviceEnvelope.updateMany.mock.invocationCallOrder[0],
      );
    });
  });

  describe('countMissingEnvelopes', () => {
    it("counts approved devices without a live envelope at each group's version", async () => {
      mocks.groupKeys.findMany.mockResolvedValue([
        { groupId, currentGdekVersion: 2 },
      ]);
      mocks.groupDevice.count.mockResolvedValue(3);

      await expect(countMissingEnvelopes([groupId])).resolves.toBe(3);

      expect(mocks.groupDevice.count).toHaveBeenCalledWith({
        where: {
          groupId,
          status: 'APPROVED',
          device: {
            status: 'ACTIVE',
            envelopes: {
              none: { groupId, envelopeVersion: 2, deletedAt: null },
            },
          },
        },
      });
    });
  });

  describe('startEnvelopeJob', () => {
    const startJob = (groupIds = [groupId]) =>
      startEnvelopeJob(actor, projectId, groupIds, PASSPHRASE, 'ROTATION');

    const finishedWith = () =>
      (
        mocks.envelopeJob.updateMany.mock.calls as [
          {
            where: { groupId: { in: string[] } };
            data: { status?: string; failureReason?: string | null };
          },
        ][]
      )
        .map(([update]) => update)
        .filter(({ data }) => data.status);

    beforeEach(() => {
      mocks.groupKeys.findMany.mockResolvedValue([
        { groupId, currentGdekVersion: 2 },
      ]);
      mocks.groupDevice.count.mockResolvedValue(1);
      mocks.groupDevice.findMany.mockResolvedValue([]);
    });

    const pageAfter = (call: number) =>
      (
        mocks.groupDevice.findMany.mock.calls[call] as [
          { where: { id?: { gt: string } } },
        ]
      )[0].where.id;

    it('continues from the last row, then checks once more from the top', async () => {
      mocks.groupDevice.findMany
        .mockResolvedValueOnce([row('dvc_1'), row('dvc_2')])
        .mockResolvedValueOnce([row('dvc_3')])
        .mockResolvedValueOnce([]);

      await startJob();
      await jobFinished();

      expect(mocks.groupDevice.findMany).toHaveBeenCalledTimes(4);
      expect(mocks.groupDevice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { id: 'asc' } }),
      );
      expect(pageAfter(0)).toBeUndefined();
      expect(pageAfter(1)).toEqual({ gt: 'row-dvc_2' });
      expect(pageAfter(2)).toEqual({ gt: 'row-dvc_3' });
      expect(pageAfter(3)).toBeUndefined();
    });

    it('picks up a device added behind the job in the last pass', async () => {
      mocks.groupDevice.findMany
        .mockResolvedValueOnce([row('dvc_2')])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row('dvc_1')])
        .mockResolvedValueOnce([]);

      await startJob();
      await jobFinished();

      expect(mocks.kmsCall).toHaveBeenCalledTimes(2);
      expect(mocks.groupDevice.findMany).toHaveBeenCalledTimes(5);
      expect(pageAfter(4)).toBeUndefined();
    });

    it('records the job as running before it resolves', async () => {
      mocks.groupDevice.findMany.mockResolvedValue([]);

      await startJob();

      expect(mocks.envelopeJob.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { groupId },
          create: expect.objectContaining({
            groupId,
            kind: 'ROTATION',
            gdekVersion: 2,
            envelopeCount: 1,
            status: 'RUNNING',
            dismissedAt: null,
          }),
        }),
      );
    });

    it('records nothing to dismiss for a group with nothing missing', async () => {
      mocks.groupDevice.count.mockResolvedValue(0);

      await startJob();
      await jobFinished();

      expect(mocks.envelopeJob.upsert).not.toHaveBeenCalled();
      expect(mocks.groupDevice.findMany).not.toHaveBeenCalled();
      expect(mocks.envelopeJob.updateMany).toHaveBeenCalledWith({
        where: { groupId: { in: [groupId] }, status: { not: 'COMPLETED' } },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      });
    });

    it('updates lastActiveAt after each batch, and records completion', async () => {
      mocks.groupDevice.findMany
        .mockResolvedValueOnce([row('dvc_1')])
        .mockResolvedValueOnce([]);

      await startJob();
      await jobFinished();

      expect(mocks.envelopeJob.updateMany).toHaveBeenCalledWith({
        where: { jobId: expect.any(String), groupId: { in: [groupId] } },
        data: { lastActiveAt: expect.any(Date) },
      });
      expect(mocks.envelopeJob.updateMany).toHaveBeenCalledWith({
        where: { jobId: expect.any(String), groupId: { in: [groupId] } },
        data: {
          status: 'COMPLETED',
          failureReason: null,
          finishedAt: expect.any(Date),
        },
      });
    });

    it.each([
      ['WRONG_PASSPHRASE', new IncorrectPassphraseException()],
      ['KMS_UNAVAILABLE', new ServiceUnavailableException()],
    ])('records %s when the KMS call fails', async (reason, error) => {
      mocks.groupDevice.findMany.mockResolvedValue([row('dvc_1')]);
      mocks.kmsCall.mockRejectedValue(error);

      await startJob();
      await jobFinished();

      expect(finishedWith()).toEqual([
        {
          where: expect.anything(),
          data: expect.objectContaining({
            status: 'FAILED',
            failureReason: reason,
          }),
        },
      ]);
    });

    it('records INTERRUPTED when something other than the KMS fails', async () => {
      mocks.groupDevice.findMany.mockRejectedValue(new Error('database'));

      await startJob();
      await jobFinished();

      expect(finishedWith()[0].data.failureReason).toBe('INTERRUPTED');
    });

    it('stops the groups it has not reached with the one that failed', async () => {
      const otherGroupId = '11111111-7425-40de-944b-e07fc1f90ae7';
      mocks.groupKeys.findMany.mockResolvedValue([
        { groupId, currentGdekVersion: 2 },
        { groupId: otherGroupId, currentGdekVersion: 1 },
      ]);
      mocks.groupDevice.findMany.mockResolvedValue([row('dvc_1')]);
      mocks.kmsCall.mockRejectedValue(new ServiceUnavailableException());

      await startJob([groupId, otherGroupId]);
      await jobFinished();

      expect(finishedWith()[0].where.groupId.in).toEqual([
        groupId,
        otherGroupId,
      ]);
    });

    it('still runs if the job could not be recorded', async () => {
      mocks.envelopeJob.upsert.mockRejectedValue(new Error('database'));
      mocks.groupDevice.findMany
        .mockResolvedValueOnce([row('dvc_1')])
        .mockResolvedValueOnce([]);

      await expect(startJob()).resolves.toBeUndefined();
      await jobFinished();

      expect(mocks.kmsCall).toHaveBeenCalledTimes(1);
    });

    it('creates envelopes in batches until none are missing', async () => {
      mocks.groupDevice.findMany
        .mockResolvedValueOnce([row('dvc_1'), row('dvc_2')])
        .mockResolvedValueOnce([row('dvc_3')])
        .mockResolvedValueOnce([]);

      await startJob();
      await jobFinished();

      expect(mocks.kmsCall).toHaveBeenCalledTimes(3);
      expect(mocks.deviceEnvelope.createMany).toHaveBeenCalledTimes(2);
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: actor,
          action: 'device.envelopes_created',
          projectId,
          metadata: { groupId, gdekVersion: 2, count: 2 },
        },
      });
      expect(mocks.groupDevice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps what succeeded and stops without retrying when the KMS fails', async () => {
      mocks.groupDevice.findMany.mockResolvedValueOnce([
        row('dvc_1'),
        row('dvc_2'),
      ]);
      mocks.kmsCall
        .mockResolvedValueOnce({ EnvelopeJson: '{"device":"dvc_1"}' })
        .mockRejectedValueOnce(new ServiceUnavailableException());

      await startJob();
      await jobFinished();

      expect(mocks.kmsCall).toHaveBeenCalledTimes(2);
      expect(mocks.deviceEnvelope.createMany).toHaveBeenCalledTimes(1);
      expect(mocks.groupDevice.findMany).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('stops on a wrong passphrase', async () => {
      mocks.groupDevice.findMany.mockResolvedValue([row('dvc_1')]);
      mocks.kmsCall.mockRejectedValue(new IncorrectPassphraseException());

      await startJob();
      await jobFinished();

      expect(mocks.kmsCall).toHaveBeenCalledTimes(1);
      expect(mocks.deviceEnvelope.createMany).not.toHaveBeenCalled();
    });

    it('stops when a newer rotation has its own job', async () => {
      mocks.groupKeys.findFirst
        .mockResolvedValueOnce(groupKeys(2))
        .mockResolvedValueOnce(groupKeys(3));
      mocks.groupDevice.findMany.mockResolvedValueOnce([row('dvc_1')]);

      await startJob();
      await jobFinished();

      expect(mocks.kmsCall).toHaveBeenCalledTimes(1);
      expect(mocks.groupDevice.findMany).toHaveBeenCalledTimes(1);
    });

    it('stops when the group was deleted', async () => {
      mocks.groupKeys.findFirst.mockResolvedValue(null);

      await startJob();
      await jobFinished();

      expect(mocks.groupDevice.findMany).not.toHaveBeenCalled();
    });

    it('never lets a failure escape, and keeps the passphrase out of logs and audit', async () => {
      mocks.groupDevice.findMany.mockRejectedValue(new Error(PASSPHRASE));

      await startJob();
      await jobFinished();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSPHRASE);
      expect(JSON.stringify(mocks.auditEvent.create.mock.calls)).not.toContain(
        PASSPHRASE,
      );
    });
  });
});
