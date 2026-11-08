import { createHash, X509Certificate } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DevicePeer } from '../engine/device-peer.js';
import { KMS_UNAVAILABLE, kmsCall } from '../kms/kms-call.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';
import { auditEvent } from './audit.js';
import { isUniqueViolation } from './cipseq-errors.js';
import {
  certificateFailure,
  checkCertificate,
  isCurrentCertificate,
} from './device-certificates.js';
import { type CipSeqTransaction, withDeviceLock } from './device-lock.js';

const logger = new Logger('DeviceCertificates');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_ATTEMPTS_PER_HOUR = 30;
const NEW_CERTIFICATE_LIMITS = {
  ENROL: { max: 5, windowMs: HOUR_MS },
  RENEW: { max: 5, windowMs: DAY_MS },
} as const;
const MAX_CSR_BYTES = 4096;

const CSR_PEM =
  /^\s*-----BEGIN CERTIFICATE REQUEST-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE REQUEST-----\s*$/;
const KMS_SERIAL = /^[1-9a-f][0-9a-f]{0,31}$/;

export type IssueRequest =
  | { operation: 'ENROL'; deviceId: string; actorId: string; body: unknown }
  | { operation: 'RENEW'; deviceId: string; peer: DevicePeer; body: unknown };

// The agreed contract with the engine: exactly these four fields. A strict client
// may reject anything extra, so adding one needs a coordinated release.
export interface CertificateResponse {
  certificate: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
}

export interface IssueResult {
  status: 200 | 201;
  certificate: CertificateResponse;
}

interface StoredCertificate {
  serialNumber: string;
  certificatePem: string;
  notBefore: Date;
  notAfter: Date;
  issuedVia: 'ENROL' | 'RENEW';
  renewedFromSerial: string | null;
  supersededAt: Date | null;
  revokedAt: Date | null;
}

interface IssuedLeaf {
  serialNumber: string;
  publicKeySha256: string;
  certificatePem: string;
  notBefore: Date;
  notAfter: Date;
}

const sha256Hex = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const toResponse = (row: {
  certificatePem: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
}): CertificateResponse => ({
  certificate: row.certificatePem,
  serialNumber: row.serialNumber,
  notBefore: row.notBefore,
  notAfter: row.notAfter,
});

function limited(message: string, retryAfter: number): HttpException {
  return new HttpException(
    {
      statusCode: 429,
      message,
      retryAfter: Math.max(1, Math.ceil(retryAfter)),
    },
    429,
  );
}

// The body is parsed by hand, inside the first transaction, so that a bad CSR from
// a known device still counts against its limit.
export function parseCsr(body: unknown): Buffer {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('csr' in body) ||
    typeof body.csr !== 'string'
  ) {
    throw new BadRequestException(
      'Supply only csr: one PEM CERTIFICATE REQUEST.',
    );
  }
  const match = CSR_PEM.exec(body.csr);
  if (!match) {
    throw new BadRequestException(
      'csr must contain exactly one PEM CERTIFICATE REQUEST.',
    );
  }
  const base64 = match[1].replace(/[\r\n]/g, '');
  const der = Buffer.from(base64, 'base64');
  if (
    der.length === 0 ||
    der.length > MAX_CSR_BYTES ||
    der.toString('base64') !== base64
  ) {
    throw new BadRequestException(
      'CSR DER must be canonical base64 and at most 4096 bytes.',
    );
  }
  // The KMS verifies the signature and the curve.
  return der;
}

// Oldest first, so the first row is the next to leave the window. Returns how many
// seconds to wait, or null while under the limit.
async function secondsUntilBelowLimit(
  max: number,
  windowMs: number,
  now: number,
  rows: (take: number, since: Date) => Promise<{ createdAt: Date }[]>,
): Promise<number | null> {
  const found = await rows(max, new Date(now - windowMs));
  if (found.length < max) {
    return null;
  }
  return (found[0].createdAt.getTime() + windowMs - now) / 1000;
}

function newCertificateLimit(
  tx: CipSeqTransaction,
  deviceId: string,
  operation: IssueRequest['operation'],
  now: number,
): Promise<number | null> {
  const { max, windowMs } = NEW_CERTIFICATE_LIMITS[operation];
  return secondsUntilBelowLimit(max, windowMs, now, (take, since) =>
    tx.deviceCertificate.findMany({
      where: { deviceId, issuedVia: operation, createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      take,
      select: { createdAt: true },
    }),
  );
}

// An exact retry of a CSR already issued. The KMS isn't called again.
function replay(
  request: IssueRequest,
  row: StoredCertificate,
  now: number,
): IssueResult | HttpException {
  const sameRenewal =
    request.operation === 'ENROL' ||
    (row.issuedVia === 'RENEW' &&
      (row.renewedFromSerial === request.peer.serial ||
        row.serialNumber === request.peer.serial));
  if (isCurrentCertificate(row, now) && sameRenewal) {
    return { status: 200, certificate: toResponse(row) };
  }
  return new ConflictException(
    'This certificate request belongs to a retired certificate. Generate a new key and certificate request.',
  );
}

interface Prepared {
  csrDer: Buffer;
  csrSha256: string;
  ownerId: string;
}

// Runs inside the transaction: a refusal is returned, not thrown, so the attempt
// row commits and the limit keeps counting.
async function prepare(
  tx: CipSeqTransaction,
  request: IssueRequest,
): Promise<Prepared | IssueResult | HttpException> {
  const { deviceId } = request;
  const now = Date.now();
  const device = await tx.device.findUnique({
    where: { id: deviceId },
    select: { userId: true, status: true },
  });

  if (request.operation === 'ENROL') {
    // The same answer for unknown devices and other people's.
    if (!device || device.userId !== request.actorId) {
      return new NotFoundException();
    }
    if (device.status !== 'ACTIVE') {
      return new ForbiddenException('The device must be active.');
    }
  } else {
    const presented = await checkCertificate(request.peer, undefined, tx);
    if (presented instanceof HttpException) {
      return presented;
    }
    if (request.peer.deviceId !== deviceId || !device) {
      return new ForbiddenException('The device must match the certificate.');
    }
  }

  const waitForAttempt = await secondsUntilBelowLimit(
    MAX_ATTEMPTS_PER_HOUR,
    HOUR_MS,
    now,
    (take, since) =>
      tx.deviceCertificateAttempt.findMany({
        where: { deviceId, createdAt: { gt: since } },
        orderBy: { createdAt: 'asc' },
        take,
        select: { createdAt: true },
      }),
  );
  if (waitForAttempt !== null) {
    return limited('Too many certificate requests.', waitForAttempt);
  }
  // Rows past the window can't affect the limit any more, so the table stays small.
  await tx.deviceCertificateAttempt.deleteMany({
    where: { deviceId, createdAt: { lte: new Date(now - HOUR_MS) } },
  });
  await tx.deviceCertificateAttempt.create({
    data: { deviceId, operation: request.operation },
  });

  let csrDer: Buffer;
  try {
    csrDer = parseCsr(request.body);
  } catch (error) {
    if (error instanceof HttpException) {
      return error;
    }
    throw error;
  }
  const csrSha256 = sha256Hex(csrDer);

  const existing = await tx.deviceCertificate.findUnique({
    where: { deviceId_csrSha256: { deviceId, csrSha256 } },
  });
  if (existing) {
    return replay(request, existing, now);
  }

  if (request.operation === 'RENEW') {
    const presenter = await tx.deviceCertificate.findUnique({
      where: { serialNumber: request.peer.serial },
      select: { supersededAt: true },
    });
    // A superseded certificate can retry its finished renewal, not start another.
    if (presenter?.supersededAt) {
      return certificateFailure();
    }
  }

  const waitForNew = await newCertificateLimit(
    tx,
    deviceId,
    request.operation,
    now,
  );
  if (waitForNew !== null) {
    return limited('Too many new certificates.', waitForNew);
  }

  return { csrDer, csrSha256, ownerId: device.userId };
}

// Anything wrong with what the KMS returned is the signer's fault, so it answers
// 503 and the engine keeps its CSR.
export function validateIssuedCertificate(
  deviceId: string,
  response: {
    certificateDer: Buffer;
    chainDer: Buffer[];
    serialNumber: string;
    publicKeySha256: Buffer;
    notBefore: Date | undefined;
    notAfter: Date | undefined;
  },
  now: number = Date.now(),
): IssuedLeaf {
  const invalid = (reason: string): never => {
    logger.error(`The KMS returned an unusable certificate: ${reason}`);
    throw new ServiceUnavailableException(KMS_UNAVAILABLE);
  };

  let leaf: X509Certificate;
  let chain: X509Certificate[];
  try {
    leaf = new X509Certificate(response.certificateDer);
    chain = response.chainDer.map((der) => new X509Certificate(der));
  } catch {
    return invalid('it could not be parsed');
  }

  const { serialNumber, notBefore, notAfter } = response;
  const leafSerial = leaf.serialNumber.toLowerCase().replace(/^0+/, '');
  if (!KMS_SERIAL.test(serialNumber) || serialNumber !== leafSerial) {
    return invalid('the serial number does not match');
  }
  if (leaf.subjectAltName !== `URI:urn:cipseq:device:${deviceId}`) {
    return invalid('the device identity does not match');
  }
  const publicKeySha256 = sha256Hex(
    leaf.publicKey.export({ type: 'spki', format: 'der' }),
  );
  if (
    response.publicKeySha256.length !== 32 ||
    response.publicKeySha256.toString('hex') !== publicKeySha256
  ) {
    return invalid('the public key hash does not match');
  }
  if (!notBefore || !notAfter || notAfter.getTime() <= now) {
    return invalid('the validity dates are missing or past');
  }

  return {
    serialNumber,
    publicKeySha256,
    // Leaf first, then any intermediates. Empty while the device CA signs directly.
    certificatePem: [leaf, ...chain].map((cert) => cert.toString()).join(''),
    notBefore,
    notAfter,
  };
}

async function commit(
  tx: CipSeqTransaction,
  request: IssueRequest,
  prepared: Prepared,
  issued: IssuedLeaf,
): Promise<IssueResult | HttpException> {
  const { deviceId } = request;
  const now = Date.now();

  // Anything may have changed during the KMS call, so everything is checked again.
  const device = await tx.device.findUnique({
    where: { id: deviceId },
    select: { userId: true, status: true },
  });
  if (!device || device.status !== 'ACTIVE') {
    return new ForbiddenException('The device must be active.');
  }

  const existing = await tx.deviceCertificate.findUnique({
    where: {
      deviceId_csrSha256: { deviceId, csrSha256: prepared.csrSha256 },
    },
  });
  if (existing) {
    // A parallel request with the same CSR got here first. This leaf is discarded,
    // and it can never authenticate because its serial is in no row.
    return replay(request, existing, now);
  }

  let previousSerial: string | null;
  if (request.operation === 'RENEW') {
    const presented = await checkCertificate(request.peer, undefined, tx);
    if (presented instanceof HttpException) {
      return presented;
    }
    if (presented.supersededAt) {
      return certificateFailure();
    }
    if (presented.publicKeySha256 === issued.publicKeySha256) {
      return new BadRequestException('A renewal needs a new key.');
    }
    previousSerial = presented.serialNumber;
  } else {
    const current = await tx.deviceCertificate.findFirst({
      where: { deviceId, revokedAt: null, supersededAt: null },
      select: { serialNumber: true },
    });
    previousSerial = current?.serialNumber ?? null;
  }

  // Parallel requests with different CSRs all passed this check earlier.
  const waitForNew = await newCertificateLimit(
    tx,
    deviceId,
    request.operation,
    now,
  );
  if (waitForNew !== null) {
    return limited('Too many new certificates.', waitForNew);
  }

  // The old certificate has to retire first, or the partial index refuses the insert.
  const retiredAt = new Date(now);
  if (request.operation === 'ENROL') {
    // No overlap: enrolling means the old key is no longer trusted.
    await tx.deviceCertificate.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: retiredAt },
    });
  } else {
    // Starts the fixed 24-hour overlap.
    await tx.deviceCertificate.update({
      where: { serialNumber: request.peer.serial },
      data: { supersededAt: retiredAt },
    });
  }

  const row = await tx.deviceCertificate.create({
    data: {
      serialNumber: issued.serialNumber,
      deviceId,
      csrSha256: prepared.csrSha256,
      publicKeySha256: issued.publicKeySha256,
      certificatePem: issued.certificatePem,
      notBefore: issued.notBefore,
      notAfter: issued.notAfter,
      issuedVia: request.operation,
      renewedFromSerial: request.operation === 'RENEW' ? previousSerial : null,
    },
  });
  await auditEvent(
    device.userId,
    request.operation === 'ENROL'
      ? 'device.certificate_enrolled'
      : 'device.certificate_renewed',
    null,
    {
      deviceId,
      serialNumber: row.serialNumber,
      previousSerial,
      notAfter: row.notAfter.toISOString(),
    },
    tx,
  );
  await tx.deviceCertificateNotice.create({
    data: {
      userId: device.userId,
      kind: request.operation,
      deviceId,
      serialNumber: row.serialNumber,
    },
  });
  return { status: 201, certificate: toResponse(row) };
}

// A renewal has no session to fail, so the owner's account is checked here. The
// auth database is separate, so this can't be part of the transaction below.
async function assertOwnerExists(deviceId: string): Promise<void> {
  const device = await cipseqPrisma.device.findUnique({
    where: { id: deviceId },
    select: { userId: true },
  });
  if (!device) {
    return; // The transaction answers for an unknown device.
  }
  const owner = await prisma.user
    .findUnique({ where: { id: device.userId }, select: { id: true } })
    .catch(() => {
      throw new ServiceUnavailableException(KMS_UNAVAILABLE);
    });
  if (!owner) {
    throw new ForbiddenException('The device owner no longer exists.');
  }
}

const isPrepared = (
  outcome: Prepared | IssueResult | HttpException,
): outcome is Prepared => 'csrDer' in outcome;

// Enrol and renew. The KMS has to stay outside any transaction, so the checks run
// twice: once before signing, to avoid signing needlessly, and once after, because
// anything may have changed during the call. The RPC is never retried; a retry from
// the engine is made safe by the unique CSR hash.
export async function issueCertificate(
  request: IssueRequest,
): Promise<IssueResult> {
  const { deviceId } = request;
  if (request.operation === 'RENEW') {
    await assertOwnerExists(deviceId);
  }

  const outcome = await withDeviceLock(deviceId, (tx) => prepare(tx, request));
  if (outcome instanceof HttpException) {
    throw outcome;
  }
  if (!isPrepared(outcome)) {
    return outcome;
  }

  let response;
  try {
    response = await kmsCall('issueDeviceCertificate', {
      deviceId,
      csrDer: outcome.csrDer,
    });
  } catch (error) {
    await auditEvent(outcome.ownerId, 'device.certificate_issue_failed', null, {
      deviceId,
      operation: request.operation,
    }).catch(() => {
      logger.warn('Could not audit a failed certificate request');
    });
    throw error;
  }
  const issued = validateIssuedCertificate(deviceId, response);

  let committed: IssueResult | HttpException;
  try {
    committed = await withDeviceLock(deviceId, (tx) =>
      commit(tx, request, outcome, issued),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const row = await cipseqPrisma.deviceCertificate.findUnique({
      where: {
        deviceId_csrSha256: { deviceId, csrSha256: outcome.csrSha256 },
      },
    });
    if (!row) {
      throw error;
    }
    committed = replay(request, row, Date.now());
  }
  if (committed instanceof HttpException) {
    throw committed;
  }
  return committed;
}
