import { randomUUID } from 'node:crypto';
import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DevicePeer } from '../engine/device-peer.js';
import { auditEvent } from './audit.js';
import { checkCertificate } from './device-certificates.js';
import { type CipSeqTransaction, withDeviceLock } from './device-lock.js';

// How long the engine waits while the background job creates a new envelope. A
// 10,000-device job takes about 5 minutes.
const ENVELOPE_NOT_READY_RETRY_AFTER_SECONDS = 30;

export interface EnvelopeDelivery {
  requestId: string;
  // Derived, because the stored row has no status.
  status: 'APPROVED' | 'SUPERSEDED';
  // The signed envelope, unchanged. The engine verifies its signature, so no value
  // inside it may ever change. Metadata goes beside it.
  envelope: unknown;
}

interface DeliveryRequest {
  peer: DevicePeer;
  userId: string;
  groupId: string;
  // Absent for encrypt, which always uses the current version.
  gdekVersion?: number;
}

function loadEnvelope(
  tx: CipSeqTransaction,
  groupId: string,
  deviceId: string,
  version: number,
) {
  return tx.deviceEnvelope.findFirst({
    where: {
      groupId,
      deviceId,
      envelopeVersion: version,
      deletedAt: null,
      device: {
        status: 'ACTIVE',
        groups: { some: { groupId, status: 'APPROVED' } },
      },
      group: { deletedAt: null, project: { deletedAt: null } },
    },
    select: { envelopeJson: true },
  });
}

async function deliver(
  tx: CipSeqTransaction,
  { peer, userId, groupId, gdekVersion }: DeliveryRequest,
): Promise<EnvelopeDelivery | HttpException> {
  // Under the lock, so that a revocation can't race the guard's check.
  const certificate = await checkCertificate(peer, userId, tx);
  if (certificate instanceof HttpException) {
    return certificate;
  }

  const group = await tx.group.findFirst({
    where: { id: groupId, deletedAt: null, project: { deletedAt: null } },
    select: {
      projectId: true,
      keys: { select: { currentGdekVersion: true } },
    },
  });
  if (!group?.keys) {
    return new NotFoundException();
  }
  const current = group.keys.currentGdekVersion;
  const version = gdekVersion ?? current;

  const row = await loadEnvelope(tx, groupId, peer.deviceId, version);
  if (!row) {
    if (gdekVersion !== undefined) {
      return new NotFoundException();
    }
    const approved = await tx.groupDevice.findFirst({
      where: {
        groupId,
        deviceId: peer.deviceId,
        status: 'APPROVED',
        device: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!approved) {
      return new NotFoundException();
    }
    // Still being created after a rotation or approval. Never fall back to an
    // older version here: encrypting with one would use a retired key.
    return new ServiceUnavailableException({
      statusCode: 503,
      message: 'The envelope for the current key is not ready yet.',
      retryAfter: ENVELOPE_NOT_READY_RETRY_AFTER_SECONDS,
    });
  }

  const requestId = randomUUID();
  await auditEvent(
    userId,
    'device.envelope_delivered',
    group.projectId,
    { deviceId: peer.deviceId, groupId, gdekVersion: version, requestId },
    tx,
  );
  return {
    requestId,
    status: version === current ? 'APPROVED' : 'SUPERSEDED',
    envelope: JSON.parse(row.envelopeJson) as unknown,
  };
}

export async function deliverEnvelope(
  request: DeliveryRequest,
): Promise<EnvelopeDelivery> {
  const outcome = await withDeviceLock(request.peer.deviceId, (tx) =>
    deliver(tx, request),
  );
  if (outcome instanceof HttpException) {
    throw outcome;
  }
  return outcome;
}
