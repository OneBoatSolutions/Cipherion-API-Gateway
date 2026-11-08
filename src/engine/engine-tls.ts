import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSecureContext, type TlsOptions } from 'node:tls';

const HANDSHAKE_TIMEOUT_MS = 10_000;

const readRequired = (name: string, env: NodeJS.ProcessEnv): Buffer => {
  const path = env[name];
  if (!path) {
    throw new Error(`${name} is not configured`);
  }
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`${name} can't be read from ${path}`, { cause: error });
  }
};

export const splitPemCertificates = (pem: string): string[] =>
  pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ??
  [];

// Everything is validated before the port opens, because a wrong key here locks out
// every installed engine. The engine checks the pin, not the gateway: this only
// makes sure the gateway serves the key whose hash shipped in the engine.
export function engineTlsOptions(
  env: NodeJS.ProcessEnv = process.env,
): TlsOptions {
  const key = readRequired('DEVICE_TLS_KEY', env);
  const cert = readRequired('DEVICE_TLS_CERT', env);
  const bundle = readRequired('DEVICE_CA_BUNDLE', env);
  const expectedPin = readRequired('DEVICE_TLS_PIN_FILE', env)
    .toString('utf8')
    .trim();

  const spki = new X509Certificate(cert).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  const keySpki = createPublicKey(createPrivateKey(key)).export({
    type: 'spki',
    format: 'der',
  });
  if (!spki.equals(keySpki)) {
    throw new Error('DEVICE_TLS_KEY does not match DEVICE_TLS_CERT.');
  }

  if (createHash('sha256').update(spki).digest('base64') !== expectedPin) {
    throw new Error(
      'The server key differs from DEVICE_TLS_PIN_FILE. Ship the new pin before changing keys.',
    );
  }

  const authorities = splitPemCertificates(bundle.toString('utf8'));
  if (
    authorities.length === 0 ||
    !authorities.every((pem) => new X509Certificate(pem).ca)
  ) {
    throw new Error('DEVICE_CA_BUNDLE must contain only CA certificates.');
  }

  const options: TlsOptions = {
    key,
    cert,
    // One PEM file holding every CA currently in a slot: old, current and new.
    ca: [bundle],
    requestCert: true,
    // Allows connections without a certificate, so that registration and enrolment
    // can work. A connection being open therefore proves nothing: see device-peer.ts.
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    // Hybrid post-quantum only, with no classical fallback.
    ecdhCurve: 'SecP256r1MLKEM768',
    ALPNProtocols: ['http/1.1'],
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
  };
  // Throws at startup if this OpenSSL build doesn't have the group.
  createSecureContext(options);
  return options;
}
