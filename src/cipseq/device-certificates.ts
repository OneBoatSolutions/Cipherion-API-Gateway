import { X509Certificate } from 'node:crypto';
import { ForbiddenException, HttpException, Logger } from '@nestjs/common';
import type { DevicePeer } from '../engine/device-peer.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';

const logger = new Logger('DeviceCertificates');

// How long a certificate keeps working after its renewal.
export const OVERLAP_MS = 24 * 60 * 60 * 1000;

export type CipSeqCertificateClient = Pick<
  typeof cipseqPrisma,
  'deviceCertificate'
>;

const CERTIFICATE_INCLUDE = {
  device: { select: { id: true, userId: true, status: true } },
} as const;

// 495 means re-enrol. 403 means enrolling again wouldn't help.
export const certificateFailure = (): HttpException =>
  new HttpException(
    {
      statusCode: 495,
      message: 'Device certificate is missing, invalid, expired or retired.',
    },
    495,
  );

function loadCertificate(
  serialNumber: string,
  client: CipSeqCertificateClient,
) {
  return client.deviceCertificate.findUnique({
    where: { serialNumber },
    include: CERTIFICATE_INCLUDE,
  });
}

export type CertificateRow = NonNullable<
  Awaited<ReturnType<typeof loadCertificate>>
>;

export function isCurrentCertificate(
  row: Pick<
    CertificateRow,
    'revokedAt' | 'supersededAt' | 'notBefore' | 'notAfter'
  >,
  now: number = Date.now(),
): boolean {
  return (
    !row.revokedAt &&
    !row.supersededAt &&
    row.notBefore.getTime() <= now &&
    row.notAfter.getTime() > now
  );
}

// Runs on every request. A TLS handshake isn't enough: revocation, re-enrolment
// and the overlap live only here, and a resumed TLS session looks authorized
// without presenting a certificate at all.
//
// Returns the refusal instead of throwing, because throwing inside a transaction
// would roll back the attempt count and the audit row written alongside it.
export async function checkCertificate(
  peer: DevicePeer,
  actorId: string | undefined,
  client: CipSeqCertificateClient = cipseqPrisma,
): Promise<CertificateRow | HttpException> {
  const row = await loadCertificate(peer.serial, client);
  const now = Date.now();
  if (
    !row ||
    row.deviceId !== peer.deviceId ||
    row.publicKeySha256 !== peer.publicKeySha256 ||
    !new X509Certificate(row.certificatePem).raw.equals(peer.raw) ||
    row.revokedAt ||
    row.notBefore.getTime() > now ||
    // Expiry wins over the overlap.
    row.notAfter.getTime() <= now ||
    (row.supersededAt && row.supersededAt.getTime() + OVERLAP_MS <= now)
  ) {
    return certificateFailure();
  }

  if (row.device.status !== 'ACTIVE') {
    return new ForbiddenException('The device must be active.');
  }
  if (actorId && row.device.userId !== actorId) {
    return new ForbiddenException(
      'The session user must own the certificate device.',
    );
  }
  return row;
}

// The guard's check. A refused certificate with a known serial is audited, in its
// own write, and a failed audit doesn't change the answer.
export async function authorizeRequest(
  peer: DevicePeer,
  actorId: string | undefined,
): Promise<CertificateRow> {
  const result = await checkCertificate(peer, actorId);
  if (!(result instanceof HttpException)) {
    return result;
  }

  try {
    const known = await loadCertificate(peer.serial, cipseqPrisma);
    if (known) {
      await auditEvent(
        known.device.userId,
        'device.certificate_refused',
        null,
        {
          deviceId: known.deviceId,
          serialNumber: known.serialNumber,
        },
      );
    }
  } catch (error) {
    logger.warn(
      `Could not audit a refused certificate: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
  }
  throw result;
}
