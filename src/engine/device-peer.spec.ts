import { X509Certificate } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import { TestPki } from '../../test/helpers/test-pki.js';
import { devicePeer } from './device-peer.js';

vi.mock('../lib/cipseq-prisma.js', () => ({ cipseqPrisma: {} }));

const deviceId = `dvc_${'A'.repeat(43)}`;

// A real TLSSocket instance with the handshake's outcome filled in.
function requestWith(authorized: boolean, certificate?: X509Certificate) {
  const socket = Object.create(TLSSocket.prototype) as TLSSocket;
  Object.defineProperty(socket, 'authorized', { value: authorized });
  socket.getPeerX509Certificate = () => certificate;
  return { raw: { socket } } as never;
}

const expectRefused = (request: never) => {
  try {
    devicePeer(request);
  } catch (error) {
    expect((error as { getStatus(): number }).getStatus()).toBe(495);
    return;
  }
  throw new Error('expected a 495');
};

describe('devicePeer', () => {
  const pki = new TestPki();
  const device = new X509Certificate(
    pki.forgedDeviceCertificate(deviceId).cert,
  );

  afterAll(() => pki.cleanup());

  it('reads the identity from an authorized certificate', () => {
    const peer = devicePeer(requestWith(true, device));
    expect(peer.deviceId).toBe(deviceId);
    expect(peer.publicKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(peer.raw.equals(device.raw)).toBe(true);
  });

  it('normalises the serial to how the KMS writes it', () => {
    const certificate = Object.create(device) as X509Certificate;
    Object.defineProperty(certificate, 'serialNumber', {
      value: '03EC31F5',
    });
    Object.defineProperty(certificate, 'subjectAltName', {
      value: device.subjectAltName,
    });
    Object.defineProperty(certificate, 'publicKey', {
      value: device.publicKey,
    });
    Object.defineProperty(certificate, 'keyUsage', { value: device.keyUsage });
    Object.defineProperty(certificate, 'ca', { value: false });
    Object.defineProperty(certificate, 'raw', { value: device.raw });
    expect(devicePeer(requestWith(true, certificate)).serial).toBe('3ec31f5');
  });

  it('refuses a right-looking certificate the handshake did not authorize', () => {
    expectRefused(requestWith(false, device));
  });

  it('refuses a connection with no certificate', () => {
    expectRefused(requestWith(false));
    expectRefused(requestWith(true));
  });

  it('refuses a socket that is not TLS', () => {
    expectRefused({ raw: { socket: {} } } as never);
  });

  it('refuses a certificate without a device identity', () => {
    const other = new X509Certificate(
      pki.forgedDeviceCertificate('not-a-device').cert,
    );
    expectRefused(requestWith(true, other));
  });
});
