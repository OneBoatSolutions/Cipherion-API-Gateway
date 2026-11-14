import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';
import { APIError } from 'better-auth/api';
import { redis } from '../lib/redis.js';

// Google and GitHub sign-in for the CipSeQ desktop agent (a native app, RFC 8252).
//
// 1. The agent listens on 127.0.0.1:<port>, makes a random `state` and a PKCE
//    `verifier`, and opens the browser on /desktop/start with the port, the state
//    and the verifier's S256 challenge. The flow is kept in Redis for 10 minutes.
// 2. /desktop/start sends the browser to /desktop/begin on the origin that Google
//    and GitHub return to (SOCIAL_REDIRECT_BASE_URL or BETTER_AUTH_URL), so the
//    OAuth state cookie lands on the host the callback reaches.
// 3. /desktop/begin starts Better Auth's social sign-in, which returns to
//    /desktop/finish once the user has signed in.
// 4. /desktop/finish takes the flow (once), checks that the browser's session was
//    made by this sign-in, makes a one-time code for it, clears the browser's
//    session cookie and redirects to http://127.0.0.1:<port>/callback.
// 5. The agent posts the code and its verifier to /one-time-token/verify. The code
//    is useless without the verifier, which never leaves the agent, so a code read
//    from the browser's history or by another program can't be redeemed.

export const FLOW_TTL_SECONDS = 10 * 60;
// The one-time token plugin's own lifetime is set from this (in minutes).
export const CODE_TTL_MINUTES = 3;
export const DESKTOP_PROVIDERS = ['google', 'github'] as const;
export type DesktopProvider = (typeof DESKTOP_PROVIDERS)[number];

export const FINISH_PATH = '/api/v1/auth/desktop/finish';
export const BEGIN_PATH = '/api/v1/auth/desktop/begin';

// 32 random bytes in base64url: the flow id, the state, the S256 challenge.
const RANDOM_43 = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636: 43 to 128 unreserved characters.
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
// Better Auth's one-time tokens are 32 letters and digits.
const CODE = /^[A-Za-z0-9]{16,128}$/;
// Better Auth's error codes, passed on to the agent only when they look like one.
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

const flowKey = (flowId: string) => `desktop-signin:flow:${flowId}`;

const codeKey = (code: string): string => {
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
  const digest = createHmac('sha256', secret)
    .update(`desktop-signin-code:${code}`)
    .digest('base64url');
  return `desktop-signin:code:${digest}`;
};

export interface DesktopFlow {
  provider: DesktopProvider;
  port: number;
  state: string;
  challenge: string;
  // When the flow started (ms). The session handed back must be newer.
  createdAt: number;
}

export type StartQuery = Omit<DesktopFlow, 'createdAt'>;

const single = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

// The start link's query, or undefined if any part is missing or malformed.
export function parseStartQuery(
  query: Record<string, unknown>,
  enabled: readonly string[],
): StartQuery | undefined {
  const provider = single(query.provider);
  const portText = single(query.port);
  const state = single(query.state);
  const challenge = single(query.challenge);
  const method = single(query.challenge_method) ?? 'S256';
  if (
    !provider ||
    !(DESKTOP_PROVIDERS as readonly string[]).includes(provider) ||
    !enabled.includes(provider) ||
    !portText ||
    !/^[0-9]{4,5}$/.test(portText) ||
    !state ||
    !RANDOM_43.test(state) ||
    !challenge ||
    !RANDOM_43.test(challenge) ||
    method !== 'S256'
  ) {
    return undefined;
  }
  const port = Number(portText);
  if (port < 1024 || port > 65535) {
    return undefined;
  }
  return { provider: provider as DesktopProvider, port, state, challenge };
}

export const isFlowId = (value: unknown): value is string =>
  typeof value === 'string' && RANDOM_43.test(value);

// Better Auth's error code from the query, or a generic one.
export const errorCode = (value: unknown): string => {
  const text = single(value);
  return text && ERROR_CODE.test(text) ? text : 'sign_in_failed';
};

export const newFlowId = (): string => randomBytes(32).toString('base64url');

const storeUnavailable = (cause: unknown): never => {
  throw new APIError('SERVICE_UNAVAILABLE', {
    message: 'Unavailable. Please try again shortly.',
    cause,
  });
};

// Each start writes to Redis, so starts are limited per IP. Better Auth's own
// limiter only covers its routes.
export const STARTS_PER_MINUTE = 20;
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// The client's address, by Better Auth's rule for its own limiter: a single-value
// X-Forwarded-For that is an IP address (what a proxy in front sets), otherwise
// the socket's. Keyed by this, users behind one load balancer don't share a limit.
export function clientIp(
  forwardedFor: string | string[] | undefined,
  socketIp: string,
): string {
  const value = typeof forwardedFor === 'string' ? forwardedFor.trim() : '';
  return value && !value.includes(',') && isIP(value) ? value : socketIp;
}

export async function tooManyStarts(ip: string): Promise<boolean> {
  const count = Number(
    await redis
      .eval(COUNT_SCRIPT, 1, `desktop-signin:starts:${ip}`, 60)
      .catch(storeUnavailable),
  );
  return count > STARTS_PER_MINUTE;
}

export async function saveFlow(
  flowId: string,
  flow: DesktopFlow,
): Promise<void> {
  await redis
    .set(flowKey(flowId), JSON.stringify(flow), 'EX', FLOW_TTL_SECONDS)
    .catch(storeUnavailable);
}

const parseFlow = (raw: string | null): DesktopFlow | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    const flow = JSON.parse(raw) as DesktopFlow;
    return typeof flow.port === 'number' &&
      typeof flow.state === 'string' &&
      typeof flow.challenge === 'string' &&
      typeof flow.createdAt === 'number' &&
      (DESKTOP_PROVIDERS as readonly string[]).includes(flow.provider)
      ? flow
      : undefined;
  } catch {
    return undefined;
  }
};

// Reads the flow and leaves it for /desktop/finish.
export async function readFlow(
  flowId: string,
): Promise<DesktopFlow | undefined> {
  return parseFlow(await redis.get(flowKey(flowId)).catch(storeUnavailable));
}

// True the first time a flow begins. Each begin writes Better Auth's OAuth state
// to the database, so one flow id can't be replayed to write more.
export async function firstBegin(flowId: string): Promise<boolean> {
  const set = await redis
    .set(`desktop-signin:begun:${flowId}`, '1', 'EX', FLOW_TTL_SECONDS, 'NX')
    .catch(storeUnavailable);
  return set === 'OK';
}

// Reads and deletes the flow, so a flow finishes at most once.
export async function takeFlow(
  flowId: string,
): Promise<DesktopFlow | undefined> {
  return parseFlow(await redis.getdel(flowKey(flowId)).catch(storeUnavailable));
}

// Binds a one-time code to the challenge of the flow that made it.
export async function bindCode(code: string, challenge: string): Promise<void> {
  await redis
    .set(codeKey(code), challenge, 'EX', CODE_TTL_MINUTES * 60)
    .catch(storeUnavailable);
}

const challengeOf = (verifier: string): Buffer =>
  Buffer.from(createHash('sha256').update(verifier).digest('base64url'));

// True when `verifier` belongs to the flow that made `code`. The binding is
// deleted whatever the answer, so each code gets exactly one try.
export async function codeMatchesVerifier(
  code: string,
  verifier: string,
): Promise<boolean> {
  if (!CODE.test(code)) {
    return false;
  }
  const challenge = await redis.getdel(codeKey(code)).catch(storeUnavailable);
  if (!challenge || !VERIFIER.test(verifier)) {
    return false;
  }
  const expected = Buffer.from(challenge);
  const actual = challengeOf(verifier);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Where the agent waits. Always the IPv4 loopback address, never `localhost`,
// which can resolve to something else (RFC 8252 section 8.3).
export function loopbackUrl(
  flow: Pick<DesktopFlow, 'port' | 'state'>,
  result: { code: string } | { error: string },
): string {
  const url = new URL(`http://127.0.0.1:${flow.port}/callback`);
  if ('code' in result) {
    url.searchParams.set('code', result.code);
  } else {
    url.searchParams.set('error', result.error);
  }
  url.searchParams.set('state', flow.state);
  return url.toString();
}

// The origin Google and GitHub return to: the OAuth state cookie must be set there.
export function socialOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SOCIAL_REDIRECT_BASE_URL || env.BETTER_AUTH_URL || '').replace(
    /\/+$/,
    '',
  );
}

const PAGE_STYLE =
  'body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2933}h1{font-size:1.25rem}';

// A page for a link that can't go on to the agent. Fixed text only: nothing from
// the request is written into it.
export function messagePage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;
