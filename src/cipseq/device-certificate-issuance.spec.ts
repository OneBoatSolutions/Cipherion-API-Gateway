import { createHash, X509Certificate } from 'node:crypto';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TestPki } from '../../test/helpers/test-pki.js';
import {
  parseCsr,
  validateIssuedCertificate,
} from './device-certificate-issuance.js';

vi.mock('../lib/cipseq-prisma.js', () => ({ cipseqPrisma: {} }));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../kms/kms-call.js', () => ({
  KMS_UNAVAILABLE: 'Unavailable.',
  kmsCall: vi.fn(),
}));

const deviceId = `dvc_${'A'.repeat(43)}`;

describe('parseCsr', () => {
  const pki = new TestPki();
  const { csr } = pki.csr();

  afterAll(() => pki.cleanup());

  it('returns the DER of one PEM certificate request', () => {
    const der = parseCsr({ csr });
    expect(der.length).toBeGreaterThan(0);
    expect(der.toString('base64')).toBe(
      csr.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''),
    );
  });

  it('gives the same DER for different PEM wrapping', () => {
    const body = csr.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
    const rewrapped = `-----BEGIN CERTIFICATE REQUEST-----\r\n${body.match(/.{1,40}/g)?.join('\r\n')}\r\n-----END CERTIFICATE REQUEST-----\r\n`;
    expect(parseCsr({ csr: rewrapped }).equals(parseCsr({ csr }))).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['an array', [csr]],
    ['a string', csr],
    ['an extra field', { csr, name: 'x' }],
    ['a csr that is not a string', { csr: 1 }],
    ['two requests', { csr: `${csr}${csr}` }],
    [
      'a certificate',
      { csr: csr.replaceAll('CERTIFICATE REQUEST', 'CERTIFICATE') },
    ],
    [
      'base64 that is not canonical',
      {
        csr: '-----BEGIN CERTIFICATE REQUEST-----\nAB=C\n-----END CERTIFICATE REQUEST-----',
      },
    ],
    [
      'more than 4096 bytes',
      {
        csr: `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.alloc(4097, 1).toString('base64')}\n-----END CERTIFICATE REQUEST-----`,
      },
    ],
  ])('refuses %s', (_name, body) => {
    expect(() => parseCsr(body)).toThrow(BadRequestException);
  });
});

describe('validateIssuedCertificate', () => {
  const pki = new TestPki();
  const leaf = new X509Certificate(pki.forgedDeviceCertificate(deviceId).cert);
  const now = Date.now();
  const response = () => ({
    certificateDer: leaf.raw,
    chainDer: [] as Buffer[],
    serialNumber: leaf.serialNumber.toLowerCase().replace(/^0+/, ''),
    publicKeySha256: createHash('sha256')
      .update(leaf.publicKey.export({ type: 'spki', format: 'der' }))
      .digest(),
    notBefore: new Date(now - 1000) as Date | undefined,
    notAfter: new Date(now + 60_000) as Date | undefined,
  });

  afterAll(() => pki.cleanup());

  it('accepts a matching certificate and keeps it as PEM', () => {
    const issued = validateIssuedCertificate(deviceId, response(), now);
    expect(issued.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(issued.publicKeySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['DER that cannot be parsed', { certificateDer: Buffer.from('nope') }],
    ['a different serial', { serialNumber: 'abc' }],
    ['a serial with an upper-case letter', { serialNumber: 'ABC' }],
    ['a key hash of the wrong length', { publicKeySha256: Buffer.alloc(31) }],
    ['a different key hash', { publicKeySha256: Buffer.alloc(32) }],
    ['no start date', { notBefore: undefined }],
    ['no end date', { notAfter: undefined }],
    ['an end date in the past', { notAfter: new Date(now - 1) }],
  ])('answers 503 to %s', (_name, change) => {
    expect(() =>
      validateIssuedCertificate(deviceId, { ...response(), ...change }, now),
    ).toThrow(ServiceUnavailableException);
  });

  it('answers 503 to a certificate for another device', () => {
    expect(() =>
      validateIssuedCertificate(`dvc_${'B'.repeat(43)}`, response(), now),
    ).toThrow(ServiceUnavailableException);
  });
});
