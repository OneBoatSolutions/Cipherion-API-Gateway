import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { setupOpenApi } from './openapi.js';

const { generateOpenAPISchema } = vi.hoisted(() => ({
  generateOpenAPISchema: vi.fn(),
}));

vi.mock('./config/env.js', () => ({
  apiDocsEnabled: false,
  trustedOrigins: [],
}));
vi.mock('./auth.js', () => ({ auth: { api: { generateOpenAPISchema } } }));
// app.setup.js (for API_PREFIX) loads the rate-limit hook, which needs Redis.
vi.mock('./lib/redis.js', () => ({ redis: {} }));

describe('setupOpenApi', () => {
  it('serves no docs when they are disabled (production)', async () => {
    const setup = vi.spyOn(SwaggerModule, 'setup');
    const createDocument = vi.spyOn(SwaggerModule, 'createDocument');

    await setupOpenApi({} as NestFastifyApplication);

    expect(createDocument).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(generateOpenAPISchema).not.toHaveBeenCalled();
  });
});
