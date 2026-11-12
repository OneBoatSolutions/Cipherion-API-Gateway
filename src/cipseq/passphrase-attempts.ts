import {
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { redis } from '../lib/redis.js';

// The KMS keeps no state, so it can't count guesses: the gateway does, per project.
export const MAX_PASSPHRASE_ATTEMPTS = 5;
export const PASSPHRASE_ATTEMPTS_WINDOW_SECONDS = 15 * 60;

// The first increment starts the window. Atomic, so a crash between the two
// commands can't leave a counter that never expires.
const RESERVE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// Only if the key still exists: a DECR on an expired key would create a negative
// counter with no expiry, which would allow extra guesses for good.
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

const logger = new Logger('CipSeq');

const attemptsKey = (projectId: string) =>
  `cipseq:passphrase-attempts:${projectId}`;

// Counted before the KMS call, so parallel guesses can't get past the limit.
// Fails closed: if Redis is down, the passphrase isn't checked at all.
export async function reservePassphraseAttempt(
  projectId: string,
): Promise<void> {
  let count: number;
  try {
    count = Number(
      await redis.eval(
        RESERVE_SCRIPT,
        1,
        attemptsKey(projectId),
        PASSPHRASE_ATTEMPTS_WINDOW_SECONDS,
      ),
    );
  } catch {
    throw new ServiceUnavailableException(
      'Unavailable. Please try again shortly.',
    );
  }

  if (count > MAX_PASSPHRASE_ATTEMPTS) {
    throw new HttpException(
      'Too many incorrect passphrases. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// For a failure that says nothing about the passphrase, such as a KMS outage.
export async function releasePassphraseAttempt(
  projectId: string,
): Promise<void> {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, attemptsKey(projectId));
  } catch {
    logger.warn('Could not release a passphrase attempt');
  }
}

// The rotation has already committed by now, so a Redis failure must not fail
// the request. The counter just expires on its own.
export async function clearPassphraseAttempts(
  projectId: string,
): Promise<void> {
  try {
    await redis.del(attemptsKey(projectId));
  } catch {
    logger.warn('Could not clear the passphrase attempts');
  }
}
