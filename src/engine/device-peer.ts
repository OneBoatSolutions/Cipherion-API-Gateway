import { createHash } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import type { FastifyRequest } from 'fastify';
import { certificateFailure } from '../cipseq/device-certificates.js';

export interface DevicePeer {
  deviceId: string;
  serial: string;
  raw: Buffer;
  publicKeySha256: string;
}

const DEVICE_SAN = /^URI:urn:cipseq:device:(dvc_[A-Za-z0-9_-]{43})$/;
const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2';

// Only the socket establishes identity, never a header or the body. The listener
// allows connections without a valid certificate so that enrolment can work, so an
// open connection proves nothing: `authorized` is what separates a certificate from
// our CAs from a self-made one with the right-looking device id.
export function devicePeer(request: Pick<FastifyRequest, 'raw'>): DevicePeer {
  const socket = request.raw.socket;
  if (!(socket instanceof TLSSocket) || !socket.authorized) {
    throw certificateFailure();
  }
  const certificate = socket.getPeerX509Certificate();
  if (!certificate) {
    throw certificateFailure();
  }

  const match = DEVICE_SAN.exec(certificate.subjectAltName ?? '');
  const { publicKey, keyUsage } = certificate;
  if (
    !match ||
    certificate.ca ||
    publicKey.asymmetricKeyType !== 'ec' ||
    publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    keyUsage?.length !== 1 ||
    keyUsage[0] !== CLIENT_AUTH_OID
  ) {
    throw certificateFailure();
  }

  // Node gives upper-case hex and keeps leading zeros. The KMS gives lower-case
  // without them, and that's how the serial is stored.
  const serial = certificate.serialNumber.toLowerCase().replace(/^0+/, '');
  if (!/^[a-f0-9]{1,32}$/.test(serial)) {
    throw certificateFailure();
  }

  return {
    deviceId: match[1],
    serial,
    raw: certificate.raw,
    publicKeySha256: createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
  };
}
