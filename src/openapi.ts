import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from './app.setup.js';
import { auth } from './auth.js';
import { apiDocsEnabled } from './config/env.js';

export const DOCS_PATH = 'docs';
const AUTH_PATH = `/${API_PREFIX}/auth`;

// Serves Swagger UI at /api/v1/docs and the JSON document at /api/v1/docs-json.
// Skipped in production. Swagger registers these routes directly on Fastify,
// so they sit outside the AuthGuard and need no session.
export async function setupOpenApi(app: NestFastifyApplication): Promise<void> {
  if (!apiDocsEnabled) {
    return;
  }

  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle('Cipherion API Gateway')
    .setDescription(
      'Unified API gateway for the Cipherion product suite, hosting the Dashboard and CipSeq backends. ' +
        'Protected routes need the session cookie set by `POST /api/v1/auth/sign-in/email`.',
    )
    .setVersion(process.env.npm_package_version ?? '0.0.1')
    .addCookieAuth('better-auth.session_token')
    // Declared up front so Swagger UI lists the sections in this order.
    .addTag('gateway', 'Gateway information')
    .addTag('health', 'Liveness and readiness probes')
    .addTag('auth', 'Better Auth endpoints (sign-up, sign-in, sessions)')
    .addTag(
      'dashboard',
      'Profile, settings and account activity of the signed-in user',
    )
    .addTag('cipseq', 'CipSeq projects and their keys')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  // Better Auth's OpenAPI types are looser than Nest's (e.g. optional parameter
  // names) but the generated document is valid OpenAPI 3.1.
  const authSchema =
    (await auth.api.generateOpenAPISchema()) as unknown as OpenAPIObject;
  addAuthEndpoints(document, authSchema);

  SwaggerModule.setup(DOCS_PATH, app, document, { useGlobalPrefix: true });
}

// Adds Better Auth's generated endpoints under /api/v1/auth. Its default
// security schemes (API key cookie, bearer) don't match how the gateway
// authenticates (the session cookie), so they are dropped.
function addAuthEndpoints(
  document: OpenAPIObject,
  authSchema: Pick<OpenAPIObject, 'paths' | 'components'>,
): void {
  for (const [path, item] of Object.entries(authSchema.paths)) {
    const operations = Object.fromEntries(
      Object.entries(item).map(([method, operation]) => [
        method,
        { ...operation, tags: ['auth'], security: undefined },
      ]),
    );
    document.paths[`${AUTH_PATH}${path}`] = operations;
  }

  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      ...authSchema.components?.schemas,
    },
  };
}
