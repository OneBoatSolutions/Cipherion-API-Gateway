import { redis } from './redis.js';

// Rate limits on the main app (src/lib/rate-limit.guard.ts and
// src/lib/ip-rate-limit.ts). Mutable only so the e2e setup can lift them, like
// the free-plan limits; rate-limits.e2e-spec.ts sets the defaults back.
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  // Every CipSeq and Dashboard write, per signed-in user.
  userWritesPerMinute: 60,
  // Every route but /api/v1/auth/*, /health and /ready, per client IP. High,
  // like the engine listener's, because offices, VPNs and mobile networks
  // share one IP: this only stops floods.
  ipRequestsPerMinute: 600,
});
export const RATE_LIMITS: {
  -readonly [K in keyof typeof RATE_LIMIT_DEFAULTS]: number;
} = { ...RATE_LIMIT_DEFAULTS };

export const RATE_LIMIT_WINDOW_SECONDS = 60;

export const TOO_MANY_REQUESTS_MESSAGE =
  'Too many requests. Please wait a moment and try again.';

// The first increment starts the window, atomically, so a crash can't leave a
// counter that never expires.
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// The number of requests counted under `key` in the current window, this one
// included. Rejects when Redis is unreachable: each caller decides whether that
// fails closed or open.
export async function countInWindow(
  key: string,
  windowSeconds: number,
): Promise<number> {
  return Number(await redis.eval(COUNT_SCRIPT, 1, key, windowSeconds));
}
