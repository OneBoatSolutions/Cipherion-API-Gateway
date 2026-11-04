import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';

interface Project {
  id: string;
  name: string;
  description: string;
  role: string;
  keyVersion: number | null;
}

const PASSPHRASE = 'correct horse battery staple';
const DESCRIPTION = 'Card and invoice data';

// Runs against the .env.dev databases and needs the KMS running. The test users
// and their CipSeq rows are removed afterwards.
describe('CipSeq projects (e2e)', () => {
  let app: NestFastifyApplication;
  let adminCookie: string;
  let otherCookie: string;
  const createdIds: string[] = [];
  const adminEmail = `e2e-project-admin-${Date.now()}@cipherion.test`;
  const otherEmail = `e2e-project-other-${Date.now()}@cipherion.test`;
  const url = '/api/v1/cipseq/projects';

  const signUp = async (email: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: {
        origin: trustedOrigins[0],
        'x-forwarded-for': uniqueClientIp(),
      },
      payload: {
        name: 'E2E Project User',
        email,
        password: 'e2e-password-123',
      },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  };

  const createProject = async (name = 'Payments'): Promise<Project> => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: adminCookie },
      payload: { name, description: DESCRIPTION },
    });
    expect(response.statusCode).toBe(201);
    const project = response.json<Project>();
    createdIds.push(project.id);
    return project;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    adminCookie = await signUp(adminEmail);
    otherCookie = await signUp(otherEmail);
  });

  afterAll(async () => {
    const where = { projectId: { in: createdIds } };
    await cipseqPrisma.$transaction([
      cipseqPrisma.auditEvent.deleteMany({ where }),
      cipseqPrisma.projectMember.deleteMany({ where }),
      cipseqPrisma.projectKeyVersion.deleteMany({ where }),
      cipseqPrisma.projectKeys.deleteMany({ where }),
      cipseqPrisma.project.deleteMany({ where: { id: { in: createdIds } } }),
    ]);
    await deleteTestUser(adminEmail);
    await deleteTestUser(otherEmail);
    await app.close();
  });

  it('allows trusted origins to send PATCH and DELETE', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: `${url}/0f8fad5b-d9cb-469f-a165-70867728950e`,
        headers: {
          origin: trustedOrigins[0],
          'access-control-request-method': method,
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-methods']).toContain(
        method,
      );
    }
  });

  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('runs the full flow: create, initialize, read, rename, delete', async () => {
    const headers = { cookie: adminCookie };
    const created = await createProject();
    expect(created).toMatchObject({
      name: 'Payments',
      description: DESCRIPTION,
      role: 'ADMIN',
      keyVersion: null,
    });

    const keys = await cipseqPrisma.projectKeys.findUniqueOrThrow({
      where: { projectId: created.id },
    });
    expect(keys.wrappedProjectRootKey).not.toBe('');
    expect(keys.wrappedProjectEncryptionKey).toBeNull();

    const initialized = await app.inject({
      method: 'POST',
      url: `${url}/${created.id}/initialize`,
      headers,
      payload: { passphrase: PASSPHRASE },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json<Project>().keyVersion).toBe(1);

    const version = await cipseqPrisma.projectKeyVersion.findUniqueOrThrow({
      where: { projectId_version: { projectId: created.id, version: 1 } },
    });
    expect(version.wrappedProjectRootKey).toBe(keys.wrappedProjectRootKey);
    expect(version.wrappedProjectEncryptionKey).not.toBe('');
    expect(version.userPassphraseSalt).not.toBe('');
    expect(JSON.stringify(version)).not.toContain(PASSPHRASE);

    const second = await app.inject({
      method: 'POST',
      url: `${url}/${created.id}/initialize`,
      headers,
      payload: { passphrase: PASSPHRASE },
    });
    expect(second.statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url, headers });
    expect(list.json<Project[]>().map(({ id }) => id)).toContain(created.id);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `${url}/${created.id}`,
      headers,
      payload: { name: 'Billing' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Project>()).toMatchObject({
      name: 'Billing',
      description: DESCRIPTION,
    });

    const described = await app.inject({
      method: 'PATCH',
      url: `${url}/${created.id}`,
      headers,
      payload: { description: 'Invoices only' },
    });
    expect(described.statusCode).toBe(200);
    expect(described.json<Project>()).toMatchObject({
      name: 'Billing',
      description: 'Invoices only',
    });

    for (const payload of [
      { name: null },
      { description: null },
      { description: '' },
      { description: 'x'.repeat(501) },
    ]) {
      const invalid = await app.inject({
        method: 'PATCH',
        url: `${url}/${created.id}`,
        headers,
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }

    const read = await app.inject({
      method: 'GET',
      url: `${url}/${created.id}`,
      headers,
    });
    expect(Object.keys(read.json<Project>()).sort()).toEqual([
      'createdAt',
      'description',
      'id',
      'keyVersion',
      'name',
      'role',
      'updatedAt',
    ]);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${url}/${created.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `${url}/${created.id}`,
      headers,
    });
    expect(gone.statusCode).toBe(404);

    // The soft delete keeps the wrapped keys.
    await expect(
      cipseqPrisma.projectKeys.count({ where: { projectId: created.id } }),
    ).resolves.toBe(1);

    const events = await cipseqPrisma.auditEvent.findMany({
      where: { projectId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map(({ action }) => action)).toEqual([
      'project.created',
      'project.initialized',
      'project.updated',
      'project.updated',
      'project.deleted',
    ]);
    expect(JSON.stringify(events)).not.toContain(PASSPHRASE);
  });

  it("hides a project from someone who isn't a member", async () => {
    const { id } = await createProject();
    const headers = { cookie: otherCookie };

    const get = await app.inject({
      method: 'GET',
      url: `${url}/${id}`,
      headers,
    });
    expect(get.statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url, headers });
    expect(list.json<Project[]>().map((project) => project.id)).not.toContain(
      id,
    );

    const remove = await app.inject({
      method: 'DELETE',
      url: `${url}/${id}`,
      headers,
    });
    expect(remove.statusCode).toBe(404);
  });

  it('rejects invalid input without echoing the passphrase', async () => {
    const headers = { cookie: adminCookie };

    const noName = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { name: '', description: DESCRIPTION },
    });
    expect(noName.statusCode).toBe(400);

    const noDescription = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { name: 'Payments' },
    });
    expect(noDescription.statusCode).toBe(400);

    const badId = await app.inject({
      method: 'GET',
      url: `${url}/not-a-uuid`,
      headers,
    });
    expect(badId.statusCode).toBe(400);

    const { id } = await createProject();
    const shortPassphrase = 'too-short';
    const short = await app.inject({
      method: 'POST',
      url: `${url}/${id}/initialize`,
      headers,
      payload: { passphrase: shortPassphrase },
    });
    expect(short.statusCode).toBe(400);
    expect(short.body).not.toContain(shortPassphrase);
  });
});
