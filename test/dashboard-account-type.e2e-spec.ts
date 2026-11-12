import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { cipseqPrisma } from './../src/lib/cipseq-prisma.js';
import { prisma } from './../src/lib/prisma.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { signUpVerified, type SignedInUser } from './helpers/users.js';

interface AccountType {
  accountType: 'INDIVIDUAL' | 'COMPANY' | null;
  companyName: string | null;
  chosenAt: string | null;
}

// Runs against the .env.dev database; the test users (and, by cascade, their
// accountProfile rows) are removed afterwards.
describe('Dashboard account type (e2e)', () => {
  let app: NestFastifyApplication;
  let individual: SignedInUser;
  let company: SignedInUser;
  let racer: SignedInUser;
  const stamp = Date.now();
  const url = '/api/v1/dashboard/account-type';

  const put = (user: SignedInUser, payload: object) =>
    app.inject({ method: 'PUT', url, headers: { cookie: user.cookie }, payload });

  const get = async (user: SignedInUser): Promise<AccountType> => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: user.cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<AccountType>();
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

    const signUp = (name: string) =>
      signUpVerified(
        app,
        `E2E ${name}`,
        `e2e-account-type-${name}-${stamp}@cipherion.test`,
      );
    individual = await signUp('individual');
    company = await signUp('company');
    racer = await signUp('racer');
  });

  afterAll(async () => {
    await cipseqPrisma.auditEvent.deleteMany({
      where: {
        userId: { in: [individual, company, racer].map(({ id }) => id) },
      },
    });
    for (const user of [individual, company, racer]) {
      await deleteTestUser(user.email);
    }
    await app.close();
  });

  it('requires a session', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url,
        payload: method === 'PUT' ? { accountType: 'INDIVIDUAL' } : undefined,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  // PUT isn't in Fastify's default CORS methods, so browsers blocked it.
  it('allows trusted origins to send PUT', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: trustedOrigins[0],
        'access-control-request-method': 'PUT',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
  });

  it('is null before the user chooses', async () => {
    await expect(get(individual)).resolves.toEqual({
      accountType: null,
      companyName: null,
      chosenAt: null,
    });
  });

  it('sets INDIVIDUAL once and refuses COMPANY afterwards', async () => {
    const first = await put(individual, { accountType: 'INDIVIDUAL' });
    expect(first.statusCode).toBe(200);
    const chosen = first.json<AccountType>();
    expect(chosen).toMatchObject({
      accountType: 'INDIVIDUAL',
      companyName: null,
    });
    expect(Date.parse(chosen.chosenAt!)).not.toBeNaN();

    await expect(get(individual)).resolves.toEqual(chosen);

    const profile = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/profile',
      headers: { cookie: individual.cookie },
    });
    expect(profile.json()).toMatchObject({
      accountType: 'INDIVIDUAL',
      companyName: null,
    });

    const again = await put(individual, { accountType: 'INDIVIDUAL' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(chosen);

    const change = await put(individual, {
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
    });
    expect(change.statusCode).toBe(409);
    expect(change.json()).toMatchObject({
      message: 'The account type is already set. Contact support to change it.',
    });
    await expect(get(individual)).resolves.toEqual(chosen);
  });

  it('sets COMPANY with a trimmed name, renames it, and refuses INDIVIDUAL', async () => {
    const first = await put(company, {
      accountType: 'COMPANY',
      companyName: '  Acme Labs  ',
    });
    expect(first.statusCode).toBe(200);
    const { chosenAt } = first.json<AccountType>();
    expect(first.json()).toMatchObject({
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
    });

    const settings = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/settings',
      headers: { cookie: company.cookie },
    });
    expect(settings.json()).toMatchObject({
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
    });

    const rename = await put(company, {
      accountType: 'COMPANY',
      companyName: 'Acme Labs Pvt Ltd',
    });
    expect(rename.statusCode).toBe(200);
    // Renaming keeps when the type was first chosen.
    expect(rename.json()).toEqual({
      accountType: 'COMPANY',
      companyName: 'Acme Labs Pvt Ltd',
      chosenAt,
    });

    const change = await put(company, { accountType: 'INDIVIDUAL' });
    expect(change.statusCode).toBe(409);
    await expect(get(company)).resolves.toMatchObject({
      accountType: 'COMPANY',
      companyName: 'Acme Labs Pvt Ltd',
    });
  });

  // In CipSeq's audit trail, not the console. A refused change, and sending
  // the same values again, write nothing.
  it('audits the choice and the rename, and nothing else', async () => {
    await put(company, {
      accountType: 'COMPANY',
      companyName: 'Acme Labs Pvt Ltd',
    });

    const rows = await cipseqPrisma.auditEvent.findMany({
      where: { userId: company.id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, projectId: true, metadata: true },
    });
    expect(rows).toEqual([
      {
        action: 'account.type_set',
        projectId: null,
        metadata: { accountType: 'COMPANY' },
      },
      {
        action: 'account.company_renamed',
        projectId: null,
        metadata: { changed: ['companyName'] },
      },
    ]);
  });

  it.each([
    ['an unknown type', { accountType: 'NONPROFIT' }, 'accountType'],
    ['a company without a name', { accountType: 'COMPANY' }, 'companyName'],
    [
      'a blank company name',
      { accountType: 'COMPANY', companyName: '   ' },
      'companyName',
    ],
    [
      'a company name over 200 characters',
      { accountType: 'COMPANY', companyName: 'x'.repeat(201) },
      'companyName',
    ],
    [
      'a company name for an individual',
      { accountType: 'INDIVIDUAL', companyName: 'Acme Labs' },
      'companyName',
    ],
    ['an extra field', { accountType: 'INDIVIDUAL', taxId: '1' }, 'taxId'],
  ])('refuses %s with 400', async (_case, payload, property) => {
    const response = await put(racer, payload);

    expect(response.statusCode).toBe(400);
    expect(
      response
        .json<{ errors: { property: string }[] }>()
        .errors.map((error) => error.property),
    ).toContain(property);
  });

  it('keeps one row when two first choices race, and never answers 500', async () => {
    const responses = await Promise.all([
      put(racer, { accountType: 'INDIVIDUAL' }),
      put(racer, { accountType: 'COMPANY', companyName: 'Acme Labs' }),
      put(racer, { accountType: 'INDIVIDUAL' }),
    ]);
    const codes = responses.map(({ statusCode }) => statusCode);

    expect(codes.every((code) => code === 200 || code === 409)).toBe(true);
    expect(codes).toContain(200);
    const rows = await prisma.accountProfile.findMany({
      where: { userId: racer.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses a COMPANY row without a name in the database itself', async () => {
    await expect(
      prisma.accountProfile.update({
        where: { userId: company.id },
        data: { companyName: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.accountProfile.update({
        where: { userId: individual.id },
        data: { companyName: 'Acme Labs' },
      }),
    ).rejects.toThrow();
  });

  it('is deleted with the user', async () => {
    await deleteTestUser(racer.email);

    await expect(
      prisma.accountProfile.findUnique({ where: { userId: racer.id } }),
    ).resolves.toBeNull();
  });
});
