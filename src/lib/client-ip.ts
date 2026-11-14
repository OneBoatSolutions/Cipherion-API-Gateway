import { isIP } from 'node:net';

// The client's address, by Better Auth's rule for its own limiter: a
// single-value X-Forwarded-For that is an IP address, otherwise the socket's.
// In production, Coolify's Traefik replaces any X-Forwarded-For the client sent
// with the client's real address, so this is the client. Keyed by this, users
// behind one load balancer don't share a limit. The only way the main app reads
// a client IP; the engine listener uses its socket address.
export function clientIp(
  forwardedFor: string | string[] | undefined,
  socketIp: string,
): string {
  const value = typeof forwardedFor === 'string' ? forwardedFor.trim() : '';
  return value && !value.includes(',') && isIP(value) ? value : socketIp;
}
