import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { lockDevice } from './../src/cipseq/device-lock.js';
import { closeEngine, createEngineApp } from './../src/engine/engine-app.js';
import { engineTlsOptions } from './../src/engine/engine-tls.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { pinOf, TestPki } from './helpers/test-pki.js';
import { signUpVerified } from './helpers/users.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

interface TestUser {
  id: string;
  email: string;
  cookie: string;
  token: string;
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: <T = Record<string, unknown>>() => T;
}

interface Issued {
  certificate: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

interface ClientOptions {
  token?: string;
  key?: string;
  cert?: string;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  agent?: Agent;
  socket?: TLSSocket;
}

const TLS_CLIENT = {
  rejectUnauthorized: false,
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
  ecdhCurve: 'SecP256r1MLKEM768',
  ALPNProtocols: ['http/1.1'],
} as const;

const PASSPHRASE = 'correct horse battery staple';

// Needs the KMS running with `make rotate-init` and `make mtls` done, Redis, and the
// .env.dev databases. The handshakes are real: only a real TLS client can show what
// the listener's socket sees. Test users and their rows are removed afterwards.
describe('Device certificates (e2e)', () => {
  const pki = new TestPki();
  const stamp = Date.now();
  const deviceIds: string[] = [];
  const projectIds: string[] = [];
  let console_: NestFastifyApplication;
  let engine: NestFastifyApplication;
  let port: number;
  let serverPin: string;
  let serverCert: string;
  let owner: TestUser;
  let stranger: TestUser;

  const send = (
    method: string,
    path: string,
    options: ClientOptions = {},
  ): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const payload =
        options.raw ??
        (options.body === undefined ? undefined : JSON.stringify(options.body));
      const request = httpsRequest(
        {
          ...TLS_CLIENT,
          host: '127.0.0.1',
          port,
          method,
          path: `/api/v1${path}`,
          // Only when set: an undefined key would override the agent's own.
          ...(options.key && { key: options.key }),
          ...(options.cert && { cert: options.cert }),
          // With agent: false, Node would ignore createConnection.
          ...(options.socket
            ? { createConnection: () => options.socket }
            : { agent: options.agent ?? false }),
          headers: {
            ...(payload !== undefined && {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(payload)),
            }),
            ...(options.token && { authorization: `Bearer ${options.token}` }),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
              json: <T>() => JSON.parse(text) as T,
            });
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });

  const signUp = (name: string): Promise<TestUser> =>
    signUpVerified(
      console_,
      `E2E ${name}`,
      `e2e-cert-${name}-${stamp}@cipherion.test`,
    );

  const consoleCall = (
    user: TestUser,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) =>
    console_.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie: user.cookie },
      payload,
    });

  const newDeviceBody = () => {
    const deviceId = `dvc_${randomBytes(32).toString('base64url')}`;
    deviceIds.push(deviceId);
    return { deviceId, publicKey: pki.mlKemPublicKey() };
  };

  const register = async (user = owner) => {
    const body = newDeviceBody();
    const response = await send('POST', '/cipseq/devices', {
      token: user.token,
      body,
    });
    expect(response.status).toBe(201);
    return body.deviceId;
  };

  const certificatePath = (deviceId: string) =>
    `/cipseq/devices/${deviceId}/certificate`;

  // Makes a key and CSR like an engine, and enrols. Returns what it needs to connect.
  const enrol = async (deviceId: string, user = owner) => {
    const { key, csr } = pki.csr();
    const response = await send('POST', certificatePath(deviceId), {
      token: user.token,
      body: { csr },
    });
    expect(response.status, response.text).toBe(201);
    const issued = response.json<Issued>();
    return { key, csr, cert: issued.certificate, issued };
  };

  const renew = (
    deviceId: string,
    credentials: { key: string; cert: string },
    csr: string,
  ) =>
    send('POST', `${certificatePath(deviceId)}/renew`, {
      ...credentials,
      body: { csr },
    });

  // A request the certificate check runs before: 400 means the certificate passed
  // and only the body was refused, and 495 means the certificate was refused.
  const probe = (deviceId: string, options: ClientOptions): Promise<Answer> =>
    send('POST', `${certificatePath(deviceId)}/renew`, {
      ...options,
      body: { nope: true },
    });

  const handshake = (options: object): Promise<TLSSocket> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port, ...options });
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
    });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    console_ = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(console_);
    await console_.init();
    await console_.getHttpAdapter().getInstance().ready();

    const server = pki.serverCertificate();
    serverCert = readFileSync(server.cert, 'utf8');
    serverPin = pinOf(serverCert);
    const pinFile = pki.path('engine.pin');
    writeFileSync(pinFile, `${serverPin}\n`);
    engine = await createEngineApp(
      engineTlsOptions({
        DEVICE_TLS_KEY: server.key,
        DEVICE_TLS_CERT: server.cert,
        DEVICE_TLS_PIN_FILE: pinFile,
        DEVICE_CA_BUNDLE: 'certs/deploy/gateway/device-ca-trust.pem',
      }),
    );
    await engine.listen(0, '127.0.0.1');
    port = (engine.getHttpServer().address() as { port: number }).port;

    owner = await signUp('owner');
    stranger = await signUp('stranger');
  });

  afterAll(async () => {
    const where = { deviceId: { in: deviceIds } };
    // First: deliveries point at devices, groups, projects and audit rows.
    await cipseqPrisma.envelopeDelivery.deleteMany({ where });
    await cipseqPrisma.deviceEnvelope.deleteMany({ where });
    await cipseqPrisma.groupDevice.deleteMany({ where });
    await cipseqPrisma.deviceCertificateNotice.deleteMany({ where });
    await cipseqPrisma.deviceCertificateAttempt.deleteMany({ where });
    await cipseqPrisma.deviceCertificate.deleteMany({ where });
    await cipseqPrisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    const inProjects = { group: { projectId: { in: projectIds } } };
    await cipseqPrisma.envelopeJob.deleteMany({ where: inProjects });
    await cipseqPrisma.groupMember.deleteMany({ where: inProjects });
    await cipseqPrisma.groupKeyVersion.deleteMany({ where: inProjects });
    await cipseqPrisma.groupKeys.deleteMany({ where: inProjects });
    const ofProjects = { projectId: { in: projectIds } };
    await cipseqPrisma.group.deleteMany({ where: ofProjects });
    await cipseqPrisma.projectKeyVersion.deleteMany({ where: ofProjects });
    await cipseqPrisma.projectKeys.deleteMany({ where: ofProjects });
    await cipseqPrisma.project.deleteMany({
      where: { id: { in: projectIds } },
    });
    await cipseqPrisma.auditEvent.deleteMany({
      where: { userId: { in: [owner.id, stranger.id] } },
    });
    await deleteTestUser(owner.email);
    await deleteTestUser(stranger.email);
    await closeEngine(engine, 1000);
    await console_.close();
    pki.cleanup();
  });

  // A client that stays connected must not hold up shutdown forever.
  it('closes with an idle keep-alive client still connected', async () => {
    const pkiForClose = new TestPki();
    const server = pkiForClose.serverCertificate();
    const pinFile = pkiForClose.path('close.pin');
    writeFileSync(pinFile, `${pinOf(readFileSync(server.cert))}\n`);
    const closable = await createEngineApp(
      engineTlsOptions({
        DEVICE_TLS_KEY: server.key,
        DEVICE_TLS_CERT: server.cert,
        DEVICE_TLS_PIN_FILE: pinFile,
        DEVICE_CA_BUNDLE: 'certs/deploy/gateway/device-ca-trust.pem',
      }),
    );
    await closable.listen(0, '127.0.0.1');
    const closablePort = (
      closable.getHttpServer().address() as { port: number }
    ).port;

    const agent = new Agent({ ...TLS_CLIENT, keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const request = httpsRequest(
        {
          ...TLS_CLIENT,
          host: '127.0.0.1',
          port: closablePort,
          path: '/api/v1/nothing',
          agent,
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      request.on('error', reject);
      request.end();
    });
    const silent = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = connect({
        ...TLS_CLIENT,
        host: '127.0.0.1',
        port: closablePort,
      });
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
    });
    silent.on('error', () => undefined);

    const started = Date.now();
    await closeEngine(closable, 1000);
    expect(Date.now() - started).toBeLessThan(5000);
    agent.destroy();
    silent.destroy();
    pkiForClose.cleanup();
  });

  describe('listener', () => {
    it('serves the key whose hash is the pin', async () => {
      const socket = await handshake(TLS_CLIENT);
      expect(pinOf(socket.getPeerX509Certificate()?.raw as Buffer)).toBe(
        serverPin,
      );
      expect(socket.getProtocol()).toBe('TLSv1.3');
      expect(socket.alpnProtocol).toBe('http/1.1');
      socket.destroy();
    });

    it('refuses TLS 1.2 and a classical-only key exchange', async () => {
      await expect(
        handshake({
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
        }),
      ).rejects.toThrow();
      await expect(
        handshake({
          rejectUnauthorized: false,
          minVersion: 'TLSv1.3',
          ecdhCurve: 'X25519',
        }),
      ).rejects.toThrow();
    });

    it.each(['/auth/get-session', '/workspace', '/ready', '/cipseq/projects'])(
      'does not mount %s on the engine port',
      async (path) => {
        const answer = await send('GET', path, { token: owner.token });
        expect(answer.status).toBe(404);
      },
    );

    it('does not mount enrol and renew on the console port', async () => {
      const deviceId = `dvc_${'A'.repeat(43)}`;
      for (const suffix of ['', '/renew']) {
        const answer = await consoleCall(
          owner,
          'POST',
          `${certificatePath(deviceId)}${suffix}`,
          { csr: 'x' },
        );
        expect(answer.statusCode).toBe(404);
      }
    });

    it('marks responses no-store', async () => {
      const answer = await send('POST', '/cipseq/devices', {
        token: owner.token,
        body: {},
      });
      expect(answer.headers['cache-control']).toBe('no-store');
    });

    it('takes no identity from forwarded or client-certificate headers', async () => {
      const deviceId = await register();
      const { cert } = await enrol(deviceId);
      const answer = await send('POST', `${certificatePath(deviceId)}/renew`, {
        headers: {
          'x-forwarded-for': '10.0.0.1',
          'x-forwarded-client-cert': encodeURIComponent(cert),
          'x-ssl-client-cert': encodeURIComponent(cert),
        },
        body: { csr: 'x' },
      });
      expect(answer.status).toBe(495);
    });

    it('refuses a session cookie-less request without a session', async () => {
      const answer = await send('POST', '/cipseq/devices', {
        body: newDeviceBody(),
      });
      expect(answer.status).toBe(401);
    });

    it('refuses an unsigned bearer token', async () => {
      const unsigned = decodeURIComponent(owner.token).split('.')[0];
      const answer = await send('POST', '/cipseq/devices', {
        token: unsigned,
        body: newDeviceBody(),
      });
      expect(answer.status).toBe(401);
    });
  });

  describe('enrolment', () => {
    it('issues a certificate with exactly four fields and the fixed profile', async () => {
      const deviceId = await register();
      const { csr } = pki.csr();
      const answer = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr },
      });

      expect(answer.status).toBe(201);
      const issued = answer.json<Issued>();
      expect(Object.keys(issued).toSorted()).toEqual([
        'certificate',
        'notAfter',
        'notBefore',
        'serialNumber',
      ]);
      const leaf = new X509Certificate(issued.certificate);
      expect(leaf.subjectAltName).toBe(`URI:urn:cipseq:device:${deviceId}`);
      expect(leaf.ca).toBe(false);
      expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
      expect(issued.serialNumber).toBe(
        leaf.serialNumber.toLowerCase().replace(/^0+/, ''),
      );
    });

    it('answers a retry with the same certificate, without a new row or notice', async () => {
      const deviceId = await register();
      const { csr, issued } = await enrol(deviceId);

      const retry = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr },
      });
      expect(retry.status).toBe(200);
      expect(retry.json<Issued>().serialNumber).toBe(issued.serialNumber);

      const body = csr.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
      const rewrapped = `-----BEGIN CERTIFICATE REQUEST-----\n${body.match(/.{1,40}/g)?.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
      const wrapped = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: rewrapped },
      });
      expect(wrapped.status).toBe(200);
      expect(wrapped.json<Issued>().serialNumber).toBe(issued.serialNumber);

      const where = { deviceId };
      expect(await cipseqPrisma.deviceCertificate.count({ where })).toBe(1);
      expect(await cipseqPrisma.deviceCertificateNotice.count({ where })).toBe(
        1,
      );
    });

    it('retires the old certificate at once on a new enrolment, and its CSR for good', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      expect((await probe(deviceId, first)).status).toBe(400);

      await enrol(deviceId);
      expect((await probe(deviceId, first)).status).toBe(495);

      const retired = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: first.csr },
      });
      expect(retired.status).toBe(409);
    });

    it("gives the same 404 for an unknown device and someone else's", async () => {
      const deviceId = await register();
      const { csr } = pki.csr();
      const others = await send('POST', certificatePath(deviceId), {
        token: stranger.token,
        body: { csr },
      });
      const unknown = await send(
        'POST',
        certificatePath(`dvc_${randomBytes(32).toString('base64url')}`),
        { token: owner.token, body: { csr } },
      );
      const malformed = await send('POST', certificatePath('not-a-device'), {
        token: owner.token,
        body: { csr },
      });
      expect(others.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(others.text).toBe(unknown.text);
    });

    it('answers 403 for a revoked device', async () => {
      const deviceId = await register();
      const revoked = await consoleCall(
        owner,
        'POST',
        `/cipseq/devices/${deviceId}/revoke`,
      );
      expect(revoked.statusCode).toBe(204);
      const answer = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: pki.csr().csr },
      });
      expect(answer.status).toBe(403);
    });

    it('refuses bad bodies, and counts them', async () => {
      const deviceId = await register();
      const { csr } = pki.csr();
      const extra = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr, name: 'x' },
      });
      expect(extra.status).toBe(400);
      const tooBig = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        raw: JSON.stringify({ csr: 'x'.repeat(9000) }),
      });
      expect(tooBig.status).toBe(413);
      expect(
        await cipseqPrisma.deviceCertificateAttempt.count({
          where: { deviceId },
        }),
      ).toBe(1);
    });

    it('ignores what a malicious CSR asks for', async () => {
      const deviceId = await register();
      const { csr } = pki.csr(
        'P-256',
        [
          'basicConstraints=critical,CA:TRUE',
          'extendedKeyUsage=serverAuth',
          `subjectAltName=URI:urn:cipseq:device:dvc_${'B'.repeat(43)}`,
        ],
        '/CN=cipherion-gateway',
      );
      const answer = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr },
      });
      expect(answer.status).toBe(201);
      const leaf = new X509Certificate(answer.json<Issued>().certificate);
      expect(leaf.ca).toBe(false);
      expect(leaf.subjectAltName).toBe(`URI:urn:cipseq:device:${deviceId}`);
      expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    });

    it('answers 400 to P-384 and RSA requests, from the KMS', async () => {
      const deviceId = await register();
      for (const csr of [pki.csr('P-384').csr, pki.rsaCsr()]) {
        const answer = await send('POST', certificatePath(deviceId), {
          token: owner.token,
          body: { csr },
        });
        expect(answer.status).toBe(400);
      }
    });

    it('limits requests, with Retry-After', async () => {
      const deviceId = await register();
      await cipseqPrisma.deviceCertificateAttempt.createMany({
        data: Array.from({ length: 30 }, () => ({
          deviceId,
          operation: 'ENROL' as const,
        })),
      });
      const answer = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: pki.csr().csr },
      });
      expect(answer.status).toBe(429);
      expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('limits new enrolments, but still answers an identical retry', async () => {
      const deviceId = await register();
      let last = await enrol(deviceId);
      for (let index = 0; index < 4; index++) {
        last = await enrol(deviceId);
      }
      const sixth = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: pki.csr().csr },
      });
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);

      const retry = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: last.csr },
      });
      expect(retry.status).toBe(200);
    });
  });

  describe('renewal', () => {
    it('needs only the certificate, and keeps the old one for 24 hours', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      const next = pki.csr();

      const answer = await renew(deviceId, first, next.csr);

      expect(answer.status, answer.text).toBe(201);
      const renewed = answer.json<Issued>();
      expect(renewed.serialNumber).not.toBe(first.issued.serialNumber);
      expect((await probe(deviceId, first)).status).toBe(400);
      expect(
        (await probe(deviceId, { key: next.key, cert: renewed.certificate }))
          .status,
      ).toBe(400);

      // Just past the overlap.
      await cipseqPrisma.deviceCertificate.update({
        where: { serialNumber: first.issued.serialNumber },
        data: { supersededAt: new Date(Date.now() - 24 * 3_600_000 - 1000) },
      });
      expect((await probe(deviceId, first)).status).toBe(495);
    });

    it('never lets the overlap outlast the certificate', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      expect((await renew(deviceId, first, pki.csr().csr)).status).toBe(201);
      await cipseqPrisma.deviceCertificate.update({
        where: { serialNumber: first.issued.serialNumber },
        data: { notAfter: new Date(Date.now() - 1000) },
      });
      expect((await probe(deviceId, first)).status).toBe(495);
    });

    it('refuses the same key, changing nothing', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      const answer = await renew(deviceId, first, pki.csrForKey(first.key));
      expect(answer.status).toBe(400);
      expect(
        await cipseqPrisma.deviceCertificate.count({ where: { deviceId } }),
      ).toBe(1);
      expect((await probe(deviceId, first)).status).toBe(400);
    });

    it('refuses a path for another device', async () => {
      const deviceId = await register();
      const otherDevice = await register();
      const first = await enrol(deviceId);
      const answer = await renew(otherDevice, first, pki.csr().csr);
      expect(answer.status).toBe(403);
    });

    it('lets a superseded certificate retry its renewal, but not start another', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      const next = pki.csr();
      const done = await renew(deviceId, first, next.csr);
      expect(done.status).toBe(201);
      const { supersededAt } =
        await cipseqPrisma.deviceCertificate.findUniqueOrThrow({
          where: { serialNumber: first.issued.serialNumber },
        });

      const another = await renew(deviceId, first, pki.csr().csr);
      expect(another.status).toBe(495);

      const retry = await renew(deviceId, first, next.csr);
      expect(retry.status).toBe(200);
      expect(retry.json<Issued>().serialNumber).toBe(
        done.json<Issued>().serialNumber,
      );

      const after = await cipseqPrisma.deviceCertificate.findUniqueOrThrow({
        where: { serialNumber: first.issued.serialNumber },
      });
      expect(after.supersededAt).toEqual(supersededAt);
    });

    it('limits renewals to five in 24 hours', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      const notAfter = new Date(Date.now() + 3_600_000);
      await cipseqPrisma.deviceCertificate.createMany({
        data: Array.from({ length: 5 }, (_, index) => ({
          serialNumber: `f${stamp.toString(16)}${index}`,
          deviceId,
          csrSha256: `seed-${index}`,
          publicKeySha256: `seed-${index}`,
          certificatePem: first.cert,
          notBefore: new Date(),
          notAfter,
          issuedVia: 'RENEW' as const,
          revokedAt: new Date(),
        })),
      });
      const answer = await renew(deviceId, first, pki.csr().csr);
      expect(answer.status).toBe(429);
      expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
    });

    it("refuses a device whose owner's account is gone", async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      await cipseqPrisma.device.update({
        where: { id: deviceId },
        data: { userId: `gone-${stamp}` },
      });
      const answer = await renew(deviceId, first, pki.csr().csr);
      expect(answer.status).toBe(403);
    });
  });

  describe('certificate checks', () => {
    it('refuses a look-alike certificate from an unknown CA', async () => {
      const deviceId = await register();
      await enrol(deviceId);
      const forged = pki.forgedDeviceCertificate(deviceId);
      expect((await probe(deviceId, forged)).status).toBe(495);
    });

    it('refuses a revoked certificate on a keep-alive connection and a resumed session', async () => {
      const deviceId = await register();
      const { key, cert } = await enrol(deviceId);
      const agent = new Agent({
        ...TLS_CLIENT,
        keepAlive: true,
        maxSockets: 1,
        key,
        cert,
      });

      // A TLS 1.3 session ticket arrives after the handshake.
      const first = await handshake({ ...TLS_CLIENT, key, cert });
      const ticket = await new Promise<Buffer>((resolve) => {
        first.once('session', resolve);
        first.write(
          'GET /api/v1/nothing HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
        );
        first.resume();
      });
      first.destroy();

      expect((await probe(deviceId, { agent })).status).toBe(400);

      const resumed = await handshake({ ...TLS_CLIENT, session: ticket });
      expect(resumed.isSessionReused()).toBe(true);
      expect((await probe(deviceId, { socket: resumed })).status).toBe(400);

      const revoked = await consoleCall(
        owner,
        'POST',
        `/cipseq/devices/${deviceId}/revoke`,
      );
      expect(revoked.statusCode).toBe(204);

      expect((await probe(deviceId, { agent })).status).toBe(495);
      const again = await handshake({ ...TLS_CLIENT, session: ticket });
      expect((await probe(deviceId, { socket: again })).status).toBe(495);
      agent.destroy();
    });

    it('audits a refused certificate with a known serial', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      await enrol(deviceId);
      await probe(deviceId, first);
      const rows = await cipseqPrisma.auditEvent.findMany({
        where: { userId: owner.id, action: 'device.certificate_refused' },
      });
      expect(
        rows.some(
          ({ metadata }) =>
            (metadata as { serialNumber?: string }).serialNumber ===
            first.issued.serialNumber,
        ),
      ).toBe(true);
    });
  });

  describe('races, against the real database', () => {
    it('gives two identical enrolments one 201 and one 200, with one notice', async () => {
      const deviceId = await register();
      const { csr } = pki.csr();
      const answers = await Promise.all(
        [1, 2].map(() =>
          send('POST', certificatePath(deviceId), {
            token: owner.token,
            body: { csr },
          }),
        ),
      );
      expect(
        answers.map(({ status }) => status).toSorted((a, b) => a - b),
      ).toEqual([200, 201]);
      expect(answers[0].json<Issued>().serialNumber).toBe(
        answers[1].json<Issued>().serialNumber,
      );
      const where = { deviceId };
      expect(await cipseqPrisma.deviceCertificate.count({ where })).toBe(1);
      expect(await cipseqPrisma.deviceCertificateNotice.count({ where })).toBe(
        1,
      );
    });

    it('lets one of two different renewals win, and the other gets 495', async () => {
      const deviceId = await register();
      const first = await enrol(deviceId);
      const answers = await Promise.all([
        renew(deviceId, first, pki.csr().csr),
        renew(deviceId, first, pki.csr().csr),
      ]);
      expect(
        answers.map(({ status }) => status).toSorted((a, b) => a - b),
      ).toEqual([201, 495]);
      expect(
        await cipseqPrisma.deviceCertificate.count({
          where: { deviceId, supersededAt: null, revokedAt: null },
        }),
      ).toBe(1);
    });

    it('answers 503 with Retry-After when a device stays locked, not a 500', async () => {
      const deviceId = await register();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = cipseqPrisma.$transaction(
        async (tx) => {
          await lockDevice(tx, deviceId);
          locked();
          await released;
        },
        { timeout: 15_000 },
      );
      await isLocked;

      const answer = await send('POST', certificatePath(deviceId), {
        token: owner.token,
        body: { csr: pki.csr().csr },
      });
      release();
      await holder;

      expect(answer.status, answer.text).toBe(503);
      expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('leaves no active certificate when a device is revoked during enrolment', async () => {
      for (let round = 0; round < 5; round++) {
        const deviceId = await register();
        const { csr } = pki.csr();
        await Promise.all([
          send('POST', certificatePath(deviceId), {
            token: owner.token,
            body: { csr },
          }),
          new Promise((resolve) => setTimeout(resolve, round * 10)).then(() =>
            consoleCall(owner, 'POST', `/cipseq/devices/${deviceId}/revoke`),
          ),
        ]);
        expect(
          await cipseqPrisma.deviceCertificate.count({
            where: { deviceId, revokedAt: null },
          }),
        ).toBe(0);
      }
    });
  });

  describe('envelope delivery', () => {
    const createGroup = async () => {
      const created = await consoleCall(owner, 'POST', '/cipseq/projects', {
        name: 'Payments',
        description: 'Card and invoice data',
      });
      expect(created.statusCode).toBe(201);
      const projectId = created.json<{ id: string }>().id;
      projectIds.push(projectId);
      const initialized = await consoleCall(
        owner,
        'POST',
        `/cipseq/projects/${projectId}/initialize`,
        { passphrase: PASSPHRASE },
      );
      expect(initialized.statusCode).toBe(200);
      const group = await consoleCall(
        owner,
        'POST',
        `/cipseq/projects/${projectId}/groups`,
        {
          name: 'Finance',
          description: 'Invoices and payroll',
          passphrase: PASSPHRASE,
        },
      );
      expect(group.statusCode).toBe(201);
      return { projectId, groupId: group.json<{ id: string }>().id };
    };

    // An owner's enrolled device, approved with a real signed envelope.
    const approvedDevice = async () => {
      const { projectId, groupId } = await createGroup();
      const deviceId = await register();
      const credentials = await enrol(deviceId);
      // Registering already asked for approval in the owner's groups.
      const approved = await consoleCall(
        owner,
        'POST',
        `/cipseq/projects/${projectId}/devices/${deviceId}/approve`,
        { passphrase: PASSPHRASE },
      );
      expect(approved.statusCode, approved.body).toBe(200);
      return { projectId, groupId, deviceId, credentials };
    };

    const encrypt = (
      groupId: string,
      options: ClientOptions,
    ): Promise<Answer> =>
      send('POST', '/cipseq/crypto/encrypt', {
        ...options,
        body: { groupId },
      });

    it('delivers the signed envelope unchanged, for a session and a certificate', async () => {
      const { groupId, deviceId, credentials } = await approvedDevice();
      const answer = await encrypt(groupId, {
        token: owner.token,
        key: credentials.key,
        cert: credentials.cert,
      });

      expect(answer.status, answer.text).toBe(200);
      const body = answer.json<{
        requestId: string;
        status: string;
        envelope: unknown;
      }>();
      expect(body.status).toBe('APPROVED');
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      const row = await cipseqPrisma.deviceEnvelope.findFirstOrThrow({
        where: { groupId, deviceId, deletedAt: null },
      });
      expect(body.envelope).toEqual(JSON.parse(row.envelopeJson));

      // Counted for the metrics, and linked to its audit row both ways.
      const delivery = await cipseqPrisma.envelopeDelivery.findUniqueOrThrow({
        where: { requestId: body.requestId },
        include: { auditEvent: true },
      });
      expect(delivery).toMatchObject({
        operation: 'ENCRYPT',
        status: 'APPROVED',
        userId: owner.id,
        deviceId,
        groupId,
        dataKind: null,
        sizeBytes: null,
        outcome: null,
        errorReason: null,
        engineVersion: null,
        occurredAt: null,
      });
      expect(delivery.certificateSerial).toMatch(/^[a-f0-9]+$/);
      expect(delivery.auditEvent.action).toBe('device.envelope_delivered');
      expect(delivery.auditEvent.metadata).toMatchObject({
        requestId: body.requestId,
        operation: 'ENCRYPT',
      });
    });

    it('refuses past the monthly free-plan limit, counting encryptions and decryptions apart', async () => {
      const { groupId, credentials } = await approvedDevice();
      const options = {
        token: owner.token,
        key: credentials.key,
        cert: credentials.cert,
      };
      // Earlier tests already delivered to this owner this month.
      const now = new Date();
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const used = (operation: 'ENCRYPT' | 'DECRYPT') =>
        cipseqPrisma.envelopeDelivery.count({
          where: {
            userId: owner.id,
            operation,
            createdAt: { gte: monthStart },
          },
        });
      vi.stubEnv(
        'FREE_PLAN_MAX_ENCRYPTIONS_PER_MONTH',
        String((await used('ENCRYPT')) + 1),
      );
      vi.stubEnv(
        'FREE_PLAN_MAX_DECRYPTIONS_PER_MONTH',
        String((await used('DECRYPT')) + 1),
      );

      try {
        expect((await encrypt(groupId, options)).status).toBe(200);
        const before = await used('ENCRYPT');

        const refused = await encrypt(groupId, options);
        expect(refused.status, refused.text).toBe(403);
        expect(refused.json()).toMatchObject({
          code: 'PLAN_LIMIT_REACHED',
          limit: 'encryptionsPerMonth',
          resetsAt: new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
          ).toISOString(),
        });
        // A refusal is not a delivery, so it isn't counted.
        expect(await used('ENCRYPT')).toBe(before);

        const decrypted = await send('POST', '/cipseq/crypto/decrypt', {
          ...options,
          body: { groupId, gdekVersion: 1 },
        });
        expect(decrypted.status, decrypted.text).toBe(200);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('refuses a session alone, a certificate alone and another user', async () => {
      const { groupId, credentials } = await approvedDevice();
      const certificate = { key: credentials.key, cert: credentials.cert };
      expect((await encrypt(groupId, { token: owner.token })).status).toBe(495);
      expect((await encrypt(groupId, certificate)).status).toBe(401);
      expect(
        (await encrypt(groupId, { token: stranger.token, ...certificate }))
          .status,
      ).toBe(403);
    });

    it('answers 503 with Retry-After while the new envelope is not ready, never an older one', async () => {
      const { groupId, deviceId, credentials } = await approvedDevice();
      const current = await cipseqPrisma.groupKeys.findUniqueOrThrow({
        where: { groupId },
      });
      // What a rotation leaves behind until its job reaches this device.
      await cipseqPrisma.groupKeys.update({
        where: { groupId },
        data: { currentGdekVersion: current.currentGdekVersion + 1 },
      });
      const session = {
        token: owner.token,
        key: credentials.key,
        cert: credentials.cert,
      };

      const answer = await encrypt(groupId, session);
      expect(answer.status).toBe(503);
      expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);

      const older = await send('POST', '/cipseq/crypto/decrypt', {
        ...session,
        body: { groupId, gdekVersion: current.currentGdekVersion },
      });
      expect(older.status).toBe(200);
      const delivered = older.json<{ status: string; requestId: string }>();
      expect(delivered.status).toBe('SUPERSEDED');
      // Only successful deliveries are counted: the 503 above left no row.
      expect(
        await cipseqPrisma.envelopeDelivery.findMany({
          where: { deviceId },
          select: { requestId: true, operation: true, status: true },
        }),
      ).toEqual([
        {
          requestId: delivered.requestId,
          operation: 'DECRYPT',
          status: 'SUPERSEDED',
        },
      ]);

      const missing = await send('POST', '/cipseq/crypto/decrypt', {
        ...session,
        body: { groupId, gdekVersion: current.currentGdekVersion + 5 },
      });
      expect(missing.status).toBe(404);
      expect(
        await cipseqPrisma.deviceEnvelope.count({
          where: { groupId, deviceId, deletedAt: null },
        }),
      ).toBe(1);
    });

    it('stops delivering for a group the device left, but its certificate keeps working', async () => {
      const { projectId, groupId, deviceId, credentials } =
        await approvedDevice();
      const session = {
        token: owner.token,
        key: credentials.key,
        cert: credentials.cert,
      };
      const revoked = await consoleCall(
        owner,
        'POST',
        `/cipseq/projects/${projectId}/groups/${groupId}/devices/${deviceId}/revoke`,
      );
      expect(revoked.statusCode).toBe(204);

      expect((await encrypt(groupId, session)).status).toBe(404);
      expect((await probe(deviceId, credentials)).status).toBe(400);
    });

    it('refuses a body naming another device', async () => {
      const { groupId, credentials } = await approvedDevice();
      const answer = await send('POST', '/cipseq/crypto/encrypt', {
        token: owner.token,
        key: credentials.key,
        cert: credentials.cert,
        body: { groupId, deviceId: `dvc_${'B'.repeat(43)}` },
      });
      expect(answer.status).toBe(400);
    });
  });

  describe('workspace', () => {
    it('shows the certificate and its notice until dismissed, without any key material', async () => {
      const deviceId = await register();
      const { issued } = await enrol(deviceId);

      const load = async () =>
        (await consoleCall(owner, 'GET', '/workspace')).json<{
          devices: {
            id: string;
            certificate: { serialNumber: string; state: string } | null;
          }[];
          notifications: { type: string; id: string; deviceId?: string }[];
        }>();

      const before = await load();
      expect(
        before.devices.find(({ id }) => id === deviceId)?.certificate,
      ).toMatchObject({ serialNumber: issued.serialNumber, state: 'ACTIVE' });
      const notice = before.notifications.find(
        (item) =>
          item.type === 'DEVICE_CERTIFICATE_ISSUED' &&
          item.deviceId === deviceId,
      );
      expect(notice).toBeDefined();
      expect(JSON.stringify(before)).not.toMatch(
        /PRIVATE KEY|BEGIN CERTIFICATE|envelopeJson/,
      );

      const strangers = await consoleCall(
        stranger,
        'POST',
        `/cipseq/devices/certificate-notices/${notice?.id}/dismiss`,
      );
      expect(strangers.statusCode).toBe(204);
      expect(
        (await load()).notifications.some(({ id }) => id === notice?.id),
      ).toBe(true);

      const dismissed = await consoleCall(
        owner,
        'POST',
        `/cipseq/devices/certificate-notices/${notice?.id}/dismiss`,
      );
      expect(dismissed.statusCode).toBe(204);
      expect(
        (await load()).notifications.some(({ id }) => id === notice?.id),
      ).toBe(false);
    });
  });
});
