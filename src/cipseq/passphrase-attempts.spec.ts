import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import {
  clearPassphraseAttempts,
  MAX_PASSPHRASE_ATTEMPTS,
  PASSPHRASE_ATTEMPTS_WINDOW_SECONDS,
  releasePassphraseAttempt,
  reservePassphraseAttempt,
} from './passphrase-attempts.js';

const { evalScript, del } = vi.hoisted(() => ({
  evalScript: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({ redis: { eval: evalScript, del } }));

const KEY = 'cipseq:passphrase-attempts:p1';

describe('passphrase attempts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('allows attempts up to the limit, in a window that expires', async () => {
    evalScript.mockResolvedValue(MAX_PASSPHRASE_ATTEMPTS);

    await expect(reservePassphraseAttempt('p1')).resolves.toBeUndefined();
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining('EXPIRE'),
      1,
      KEY,
      PASSPHRASE_ATTEMPTS_WINDOW_SECONDS,
    );
  });

  it('answers 429 above the limit', async () => {
    evalScript.mockResolvedValue(MAX_PASSPHRASE_ATTEMPTS + 1);

    const error: unknown = await reservePassphraseAttempt('p1').catch(
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  it('answers 503 when Redis is down, so the limit fails closed', async () => {
    evalScript.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(reservePassphraseAttempt('p1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('only gives an attempt back if the counter still exists', async () => {
    evalScript.mockResolvedValue(0);

    await releasePassphraseAttempt('p1');

    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS'),
      1,
      KEY,
    );
  });

  it('clears the counter', async () => {
    del.mockResolvedValue(1);

    await clearPassphraseAttempts('p1');

    expect(del).toHaveBeenCalledWith(KEY);
  });

  it("doesn't fail the request when releasing or clearing fails", async () => {
    evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
    del.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(releasePassphraseAttempt('p1')).resolves.toBeUndefined();
    await expect(clearPassphraseAttempts('p1')).resolves.toBeUndefined();
  });
});
