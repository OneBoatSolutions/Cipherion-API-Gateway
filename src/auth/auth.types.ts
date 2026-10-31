import type { auth } from '../auth.js';

export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = AuthSession['user'];

// Set by AuthGuard on every request that passes with a valid session.
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    session?: AuthSession['session'];
  }
}
