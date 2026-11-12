import type { auth } from '../auth.js';
import type { DevicePeer } from '../engine/device-peer.js';

export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = AuthSession['user'];

declare module 'fastify' {
  interface FastifyRequest {
    // Set by AuthGuard on every request that passes with a valid session.
    user?: AuthUser;
    session?: AuthSession['session'];
    // Set by DeviceCertificateGuard on the engine listener, from the TLS socket only.
    devicePeer?: DevicePeer;
  }
}
