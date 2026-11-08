#!/usr/bin/env node
// Creates a server key, a self-signed certificate and a pin file for the engine
// listener. Self-signed is correct here: the engine trusts the pin, not a CA.
//
//   npm run certs:engine
//   npm run certs:engine -- --host engine.example.com --name engine-server-a --dir ./keys
//
// It never replaces an existing key, because that would lock out every engine
// holding the old pin. It only renews the certificate for that key when asked, with
// --renew, which keeps the pin. For production, read docs/tls-pins.md first: run it
// on the admin machine, once for the active key and once for the spare.
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, createPrivateKey, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const EMPTY_INPUT_PIN = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'certs/engine' },
    name: { type: 'string', default: 'engine-server' },
    host: { type: 'string', default: 'localhost' },
    days: { type: 'string', default: '365' },
    renew: { type: 'boolean', default: false },
  },
});

const fail = (message) => {
  console.error(`setup-device-tls: ${message}`);
  process.exit(1);
};

if (!/^[A-Za-z0-9.-]+$/.test(values.host)) {
  fail('--host must be a plain host name or IP address.');
}
if (!/^[A-Za-z0-9_-]+$/.test(values.name)) {
  fail('--name may only contain letters, digits, - and _.');
}
if (!/^[1-9]\d*$/.test(values.days)) {
  fail('--days must be a positive whole number.');
}

const dir = resolve(values.dir);
const keyPath = join(dir, `${values.name}.key`);
const certPath = join(dir, `${values.name}.crt`);
const pinPath = join(dir, `${values.name}.spki.sha256`);

const spkiOf = (publicKey) => publicKey.export({ type: 'spki', format: 'der' });
const pinOf = (spki) => createHash('sha256').update(spki).digest('base64');

// A broken OPENSSL_CONF stops `openssl req`, so it runs with its own small config.
// Nothing goes through a shell, so no shell can rewrite /CN=... or corrupt a pipe.
function openssl(args, configDir) {
  const config = join(configDir, 'openssl.cnf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\n[dn]\n');
  const env = { ...process.env, OPENSSL_CONF: config, MSYS_NO_PATHCONV: '1' };
  const result = spawnSync('openssl', [...args, '-config', config], { env, encoding: 'utf8' });
  if (result.error) {
    fail(`could not run openssl: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`openssl failed: ${result.stderr.trim()}`);
  }
}

function certificateArgs() {
  const san = `${isIP(values.host) ? 'IP' : 'DNS'}:${values.host}`;
  return [
    '-sha256',
    '-days',
    values.days,
    '-subj',
    `/CN=${values.host}`,
    '-addext',
    `subjectAltName=${san}`,
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-addext',
    'basicConstraints=critical,CA:FALSE',
  ];
}

mkdirSync(dir, { recursive: true });
const hasKey = existsSync(keyPath);
const hasCert = existsSync(certPath);
const hasPin = existsSync(pinPath);

if (!hasKey && (hasCert || hasPin)) {
  fail(`${certPath} or its pin exists without its key. Sort that out by hand.`);
}

const workDir = mkdtempSync(join(tmpdir(), 'setup-device-tls-'));
try {
  if (!hasKey) {
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        ...certificateArgs(),
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      workDir,
    );
    chmodSync(keyPath, 0o600);
  } else if (values.renew || !hasCert) {
    openssl(['req', '-x509', '-new', '-key', keyPath, ...certificateArgs(), '-out', certPath], workDir);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const certSpki = spkiOf(new X509Certificate(readFileSync(certPath)).publicKey);
const keySpki = spkiOf(createPublicKey(createPrivateKey(readFileSync(keyPath))));
if (!certSpki.equals(keySpki)) {
  fail(`${keyPath} does not match ${certPath}.`);
}

const pin = pinOf(certSpki);
if (pin === EMPTY_INPUT_PIN || Buffer.from(pin, 'base64').length !== 32) {
  fail('the calculated pin is not valid.');
}
if (hasPin) {
  if (readFileSync(pinPath, 'utf8').trim() !== pin) {
    fail(`${pinPath} does not match this key. Never replace a key before its pin has shipped.`);
  }
} else {
  writeFileSync(pinPath, `${pin}\n`);
}

const notAfter = new X509Certificate(readFileSync(certPath)).validTo;
console.log(`Key:         ${keyPath}${hasKey ? ' (existing, kept)' : ' (new)'}`);
console.log(`Certificate: ${certPath}, valid until ${notAfter}`);
console.log(`Pin file:    ${pinPath}`);
console.log(`Pin:         ${pin}`);
