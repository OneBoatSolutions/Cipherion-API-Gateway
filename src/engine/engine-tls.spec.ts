import { readFileSync, writeFileSync } from 'node:fs';
import { pinOf, TestPki } from '../../test/helpers/test-pki.js';
import { engineTlsOptions, splitPemCertificates } from './engine-tls.js';

describe('engineTlsOptions', () => {
  const pki = new TestPki();
  const server = pki.serverCertificate();
  const other = pki.serverCertificate();
  const authority = pki.certificateAuthority();
  const secondAuthority = pki.certificateAuthority();

  const pinFile = pki.path('good.pin');
  const wrongPinFile = pki.path('wrong.pin');
  const bundle = pki.path('bundle.pem');
  writeFileSync(pinFile, `${pinOf(readFileSync(server.cert))}\n`);
  writeFileSync(wrongPinFile, `${pinOf(readFileSync(other.cert))}\n`);
  writeFileSync(
    bundle,
    readFileSync(authority.cert, 'utf8') +
      readFileSync(secondAuthority.cert, 'utf8'),
  );

  const env = (overrides = {}): NodeJS.ProcessEnv => ({
    DEVICE_TLS_KEY: server.key,
    DEVICE_TLS_CERT: server.cert,
    DEVICE_TLS_PIN_FILE: pinFile,
    DEVICE_CA_BUNDLE: bundle,
    ...overrides,
  });

  afterAll(() => pki.cleanup());

  it('builds post-quantum TLS 1.3 options that allow a missing client certificate', () => {
    const options = engineTlsOptions(env());
    expect(options).toMatchObject({
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ecdhCurve: 'SecP256r1MLKEM768',
      ALPNProtocols: ['http/1.1'],
    });
  });

  it('refuses a key that does not match the certificate', () => {
    expect(() => engineTlsOptions(env({ DEVICE_TLS_KEY: other.key }))).toThrow(
      'DEVICE_TLS_KEY does not match DEVICE_TLS_CERT',
    );
  });

  it('refuses a key that does not match the pin file', () => {
    expect(() =>
      engineTlsOptions(env({ DEVICE_TLS_PIN_FILE: wrongPinFile })),
    ).toThrow('Ship the new pin before changing keys');
  });

  it('refuses a bundle holding a certificate that is not a CA', () => {
    expect(() =>
      engineTlsOptions(env({ DEVICE_CA_BUNDLE: server.cert })),
    ).toThrow('only CA certificates');
  });

  it('refuses a bundle with no certificates', () => {
    const empty = pki.path('empty.pem');
    writeFileSync(empty, '');
    expect(() => engineTlsOptions(env({ DEVICE_CA_BUNDLE: empty }))).toThrow(
      'only CA certificates',
    );
  });

  it('names the setting when a file is missing, without reading further', () => {
    expect(() =>
      engineTlsOptions(env({ DEVICE_TLS_KEY: pki.path('missing.key') })),
    ).toThrow("DEVICE_TLS_KEY can't be read");
    expect(() => engineTlsOptions(env({ DEVICE_TLS_CERT: '' }))).toThrow(
      'DEVICE_TLS_CERT is not configured',
    );
  });

  it('splits a PEM bundle into its certificates', () => {
    expect(splitPemCertificates(readFileSync(bundle, 'utf8'))).toHaveLength(2);
  });
});
