import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Throwaway keys and certificates, made with the openssl command line. Every call
// passes its own small config, so a broken OPENSSL_CONF on the machine doesn't matter.
export class TestPki {
  readonly dir = mkdtempSync(join(tmpdir(), 'gateway-test-pki-'));
  private readonly config = join(this.dir, 'openssl.cnf');
  private counter = 0;

  constructor() {
    writeFileSync(this.config, '[req]\ndistinguished_name=dn\n[dn]\n');
  }

  private openssl(args: string[], withConfig = true): void {
    const env = {
      ...process.env,
      OPENSSL_CONF: this.config,
      MSYS_NO_PATHCONV: '1',
    };
    const result = spawnSync(
      'openssl',
      withConfig ? [...args, '-config', this.config] : args,
      { env, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
    }
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  private next(prefix: string): string {
    this.counter += 1;
    return this.path(`${prefix}-${this.counter}`);
  }

  // A key and self-signed certificate like the listener's.
  serverCertificate(host = 'localhost'): { key: string; cert: string } {
    const base = this.next('server');
    this.openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-sha256',
      '-days',
      '30',
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=DNS:${host}`,
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-keyout',
      `${base}.key`,
      '-out',
      `${base}.crt`,
    ]);
    return { key: `${base}.key`, cert: `${base}.crt` };
  }

  certificateAuthority(): { key: string; cert: string } {
    const base = this.next('ca');
    this.openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/CN=Test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
      '-keyout',
      `${base}.key`,
      '-out',
      `${base}.crt`,
    ]);
    return { key: `${base}.key`, cert: `${base}.crt` };
  }

  // A key and a CSR, as an engine makes them. `extensions` asks for things the KMS
  // must ignore, like CA:TRUE or another identity.
  csr(
    curve = 'P-256',
    extensions: string[] = [],
    subject = '/CN=device',
  ): { key: string; csr: string } {
    const base = this.next('device');
    this.openssl([
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      `ec_paramgen_curve:${curve}`,
      '-nodes',
      '-subj',
      subject,
      ...extensions.flatMap((extension) => ['-addext', extension]),
      '-keyout',
      `${base}.key`,
      '-out',
      `${base}.csr`,
    ]);
    return {
      key: readFileSync(`${base}.key`, 'utf8'),
      csr: readFileSync(`${base}.csr`, 'utf8'),
    };
  }

  // A real ML-KEM-1024 public key, through openssl because Node 22's crypto can't
  // generate one. The raw key is the end of the SubjectPublicKeyInfo.
  mlKemPublicKey(): string {
    const base = this.next('mlkem');
    this.openssl(
      ['genpkey', '-algorithm', 'ML-KEM-1024', '-out', `${base}.key`],
      false,
    );
    this.openssl(
      [
        'pkey',
        '-in',
        `${base}.key`,
        '-pubout',
        '-outform',
        'DER',
        '-out',
        `${base}.der`,
      ],
      false,
    );
    return readFileSync(`${base}.der`).subarray(-1568).toString('base64');
  }

  // A new request for a key that already exists.
  csrForKey(key: string): string {
    const base = this.next('same-key');
    writeFileSync(`${base}.key`, key);
    this.openssl([
      'req',
      '-new',
      '-key',
      `${base}.key`,
      '-subj',
      '/CN=same-key',
      '-out',
      `${base}.csr`,
    ]);
    return readFileSync(`${base}.csr`, 'utf8');
  }

  rsaCsr(): string {
    const base = this.next('rsa');
    this.openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=device',
      '-keyout',
      `${base}.key`,
      '-out',
      `${base}.csr`,
    ]);
    return readFileSync(`${base}.csr`, 'utf8');
  }

  // A client certificate with a device's exact identity, from a CA we don't trust.
  forgedDeviceCertificate(deviceId: string): { key: string; cert: string } {
    const authority = this.certificateAuthority();
    const { key, csr } = this.csr();
    const base = this.next('forged');
    writeFileSync(`${base}.csr`, csr);
    writeFileSync(
      `${base}.ext`,
      [
        `subjectAltName=URI:urn:cipseq:device:${deviceId}`,
        'extendedKeyUsage=clientAuth',
        'basicConstraints=critical,CA:FALSE',
      ].join('\n'),
    );
    this.openssl(
      [
        'x509',
        '-req',
        '-in',
        `${base}.csr`,
        '-CA',
        authority.cert,
        '-CAkey',
        authority.key,
        // The same shape as a KMS serial, which is at most 128 bits.
        '-set_serial',
        `0x1${randomBytes(15).toString('hex')}`,
        '-days',
        '5',
        '-sha256',
        '-extfile',
        `${base}.ext`,
        '-out',
        `${base}.crt`,
      ],
      false,
    );
    return { key, cert: readFileSync(`${base}.crt`, 'utf8') };
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function pinOf(certPem: string | Buffer): string {
  return createHash('sha256')
    .update(
      new X509Certificate(certPem).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('base64');
}
