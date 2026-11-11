import { Controller, Get } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import type { AuthUser } from './../src/auth/auth.types.js';
import { CurrentUser } from './../src/auth/decorators/current-user.decorator.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { signUpVerified } from './helpers/users.js';

// Test-only route, so the guard can be exercised without a production endpoint.
@Controller('guard-test')
class ProtectedTestController {
  @Get()
  whoAmI(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email };
  }
}

// Runs against the .env.dev database; the test user is removed afterwards.
describe('AuthGuard (e2e)', () => {
  let app: NestFastifyApplication;
  const email = `e2e-guard-${Date.now()}@cipherion.test`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProtectedTestController],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await deleteTestUser(email);
    await app.close();
  });

  it('rejects protected routes without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/guard-test',
    });

    expect(response.statusCode).toBe(401);
  });

  it('keeps public routes reachable without a session', async () => {
    const hello = await app.inject({ method: 'GET', url: '/api/v1' });
    expect(hello.statusCode).toBe(200);

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session',
    });
    expect(session.statusCode).toBe(200);
  });

  it('passes the signed-in user to @CurrentUser()', async () => {
    const user = await signUpVerified(app, 'E2E Guard User', email);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/guard-test',
      headers: { cookie: user.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id, email });
  });
});
