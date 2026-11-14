import { createHash } from 'node:crypto';
import { APIError } from 'better-auth/api';
import {
  bindCode,
  codeMatchesVerifier,
  errorCode,
  firstBegin,
  isFlowId,
  loopbackUrl,
  newFlowId,
  parseStartQuery,
  socialOrigin,
  takeFlow,
  tooManyStarts,
} from './desktop-sign-in.js';

const store = new Map<string, string>();
const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    set: vi.fn(),
    get: vi.fn(),
    getdel: vi.fn(),
    eval: vi.fn(),
  },
}));

vi.mock('../lib/redis.js', () => ({ redis: redisMock }));

const VERIFIER = 'v'.repeat(20) + 'ABCDEFGHIJKLMNOPQRSTUVW'; // 43 characters
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const STATE = 'S'.repeat(43);

const query = (overrides: Record<string, unknown> = {}) => ({
  provider: 'google',
  port: '53682',
  state: STATE,
  challenge: CHALLENGE,
  challenge_method: 'S256',
  ...overrides,
});

beforeEach(() => {
  store.clear();
  redisMock.set.mockImplementation(
    async (key: string, value: string, ...options: unknown[]) => {
      if (options.includes('NX') && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    },
  );
  redisMock.get.mockImplementation(
    async (key: string) => store.get(key) ?? null,
  );
  redisMock.getdel.mockImplementation(async (key: string) => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value;
  });
  redisMock.eval.mockReset();
});

describe('parseStartQuery', () => {
  it('accepts a well-formed start link for an enabled provider', () => {
    expect(parseStartQuery(query(), ['google'])).toEqual({
      provider: 'google',
      port: 53682,
      state: STATE,
      challenge: CHALLENGE,
    });
  });

  it.each([
    ['a provider that is not configured', { provider: 'github' }],
    ['an unknown provider', { provider: 'facebook' }],
    ['a privileged port', { port: '80' }],
    ['a port out of range', { port: '70000' }],
    ['a port that is not a number', { port: '12ab' }],
    ['a short state', { state: 'abc' }],
    ['a state with other characters', { state: `${'S'.repeat(42)}/` }],
    ['a missing challenge', { challenge: undefined }],
    ['the plain challenge method', { challenge_method: 'plain' }],
    ['a repeated parameter', { port: ['53682', '53683'] }],
  ])('refuses %s', (_name, overrides) => {
    expect(parseStartQuery(query(overrides), ['google'])).toBeUndefined();
  });
});

describe('codeMatchesVerifier', () => {
  const CODE = 'abcdefghijklmnopqrstuvwxyz012345';

  it('accepts the verifier of the flow that made the code, once', async () => {
    await bindCode(CODE, CHALLENGE);
    await expect(codeMatchesVerifier(CODE, VERIFIER)).resolves.toBe(true);
    await expect(codeMatchesVerifier(CODE, VERIFIER)).resolves.toBe(false);
  });

  // Better Auth's codes use a-z, A-Z, 0-9, "-" and "_", so about 2 in 3 of
  // them contain "-" or "_".
  it('accepts a code that contains "-" and "_"', async () => {
    const code = 'abc-def_ghijklmnopqrstuvwxyz0123';
    await bindCode(code, CHALLENGE);
    await expect(codeMatchesVerifier(code, VERIFIER)).resolves.toBe(true);
  });

  it('refuses another verifier, and burns the code', async () => {
    await bindCode(CODE, CHALLENGE);
    await expect(codeMatchesVerifier(CODE, 'w'.repeat(43))).resolves.toBe(
      false,
    );
    await expect(codeMatchesVerifier(CODE, VERIFIER)).resolves.toBe(false);
  });

  it('refuses a code it never bound and a malformed code', async () => {
    await expect(codeMatchesVerifier(CODE, VERIFIER)).resolves.toBe(false);
    await expect(codeMatchesVerifier('', VERIFIER)).resolves.toBe(false);
    await expect(codeMatchesVerifier('a b', VERIFIER)).resolves.toBe(false);
  });

  it('stores the code only as a keyed hash', async () => {
    await bindCode(CODE, CHALLENGE);
    expect([...store.keys()].some((key) => key.includes(CODE))).toBe(false);
  });

  it('answers 503 when Redis is down', async () => {
    redisMock.getdel.mockRejectedValueOnce(new Error('down'));
    await expect(codeMatchesVerifier(CODE, VERIFIER)).rejects.toBeInstanceOf(
      APIError,
    );
  });
});

describe('flows', () => {
  it('makes 43-character flow ids', () => {
    const id = newFlowId();
    expect(isFlowId(id)).toBe(true);
    expect(isFlowId('../x')).toBe(false);
    expect(isFlowId(undefined)).toBe(false);
  });

  it('finishes a flow at most once', async () => {
    store.set(
      `desktop-signin:flow:${'f'.repeat(43)}`,
      JSON.stringify({
        provider: 'google',
        port: 53682,
        state: STATE,
        challenge: CHALLENGE,
        createdAt: 1,
      }),
    );
    await expect(takeFlow('f'.repeat(43))).resolves.toMatchObject({
      port: 53682,
    });
    await expect(takeFlow('f'.repeat(43))).resolves.toBeUndefined();
  });

  it('ignores a stored flow of the wrong shape', async () => {
    store.set(`desktop-signin:flow:${'g'.repeat(43)}`, '{"port":"1"}');
    await expect(takeFlow('g'.repeat(43))).resolves.toBeUndefined();
  });

  it('lets a flow begin only once', async () => {
    await expect(firstBegin('h'.repeat(43))).resolves.toBe(true);
    await expect(firstBegin('h'.repeat(43))).resolves.toBe(false);
  });

  it('limits starts per IP', async () => {
    redisMock.eval.mockResolvedValueOnce(20).mockResolvedValueOnce(21);
    await expect(tooManyStarts('1.2.3.4')).resolves.toBe(false);
    await expect(tooManyStarts('1.2.3.4')).resolves.toBe(true);
  });
});

describe('loopbackUrl', () => {
  it('sends the code and state to the IPv4 loopback address', () => {
    expect(loopbackUrl({ port: 53682, state: STATE }, { code: 'abc' })).toBe(
      `http://127.0.0.1:53682/callback?code=abc&state=${STATE}`,
    );
  });

  it('sends an error instead of a code', () => {
    expect(
      loopbackUrl({ port: 53682, state: STATE }, { error: 'access_denied' }),
    ).toBe(
      `http://127.0.0.1:53682/callback?error=access_denied&state=${STATE}`,
    );
  });
});

describe('errorCode', () => {
  it('passes on a Better Auth error code and replaces anything else', () => {
    expect(errorCode('access_denied')).toBe('access_denied');
    expect(errorCode('<script>')).toBe('sign_in_failed');
    expect(errorCode(['a', 'b'])).toBe('sign_in_failed');
  });
});

describe('socialOrigin', () => {
  it('prefers SOCIAL_REDIRECT_BASE_URL and drops a trailing slash', () => {
    expect(
      socialOrigin({
        SOCIAL_REDIRECT_BASE_URL: 'https://dash.example/',
        BETTER_AUTH_URL: 'https://api.example',
      }),
    ).toBe('https://dash.example');
    expect(socialOrigin({ BETTER_AUTH_URL: 'https://api.example' })).toBe(
      'https://api.example',
    );
  });
});
