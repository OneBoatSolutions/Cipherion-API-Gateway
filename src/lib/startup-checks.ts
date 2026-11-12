import { Logger } from '@nestjs/common';
import type { SystemService } from '../generated/prisma/enums.js';
import { cipseqPool } from './cipseq-prisma.js';
import { reportEstablished } from './connection-events.js';
import { connectionErrorReason, withTimeout } from './database-watch.js';
import { checkKmsServing, closeKms } from './kms.js';
import { mailer } from './mailer.js';
import { pool } from './prisma.js';
import { redis, redisErrorReason } from './redis.js';

// Longer than the 2 s runtime checks, to allow for a slow first connection.
export const STARTUP_TIMEOUT_MS = 5000;

// One exit code per dependency, so an orchestrator or script can tell which
// one failed. Invalid configuration (env validation, unreadable certificates)
// still exits with 1.
export const EXIT_CODES: Record<SystemService, number> = {
  AUTH_DATABASE: 10,
  CIPSEQ_DATABASE: 11,
  REDIS: 12,
  KMS: 13,
  SMTP: 14,
};

export interface StartupCheck {
  service: SystemService;
  // For the log lines, e.g. "the auth database".
  label: string;
  // Where it is, never credentials: host:port and path.
  target: string;
  probe: () => Promise<unknown>;
  // A short reason from the probe's error.
  reason?: (error: unknown) => string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'unknown error';

const defaultChecks = (): StartupCheck[] => {
  const checks: StartupCheck[] = [
    {
      service: 'AUTH_DATABASE',
      label: 'the auth database',
      target: describeTarget(process.env.DATABASE_URL ?? ''),
      probe: () => pool.query('SELECT 1'),
    },
    {
      service: 'CIPSEQ_DATABASE',
      label: 'the CipSeq database',
      target: describeTarget(process.env.CIPSEQ_DATABASE_URL ?? ''),
      probe: () => cipseqPool.query('SELECT 1'),
    },
    {
      service: 'REDIS',
      label: 'Redis',
      target: describeTarget(process.env.REDIS_URL ?? ''),
      probe: () => redis.ping(),
      reason: (error) => redisErrorReason(errorMessage(error)),
    },
    {
      service: 'KMS',
      label: 'the KMS',
      target: process.env.KMS_ADDRESS ?? '',
      probe: () => checkKmsServing(STARTUP_TIMEOUT_MS),
      reason: errorMessage,
    },
  ];
  // No transport in tests (NODE_ENV=test), so nothing to check.
  if (mailer.enabled) {
    checks.push({
      service: 'SMTP',
      label: 'the SMTP server',
      target: `${process.env.EMAIL_HOST}:${process.env.EMAIL_PORT}`,
      probe: () => mailer.verify(),
      reason: errorMessage,
    });
  }
  return checks;
};

// Everything opened at import time, closed so the process can exit cleanly.
const closeAll = async (): Promise<void> => {
  await Promise.allSettled([
    pool.end(),
    cipseqPool.end(),
    Promise.resolve().then(() => redis.disconnect()),
    Promise.resolve().then(closeKms),
    Promise.resolve().then(mailer.close),
  ]);
};

// Refuses to start the gateway unless every dependency answers: each failure
// is logged with its reason, then the process exits with the code of the first
// failed one (in EXIT_CODES order), so the orchestrator's restart policy takes
// over. On success, one line is logged and a CONNECTION_ESTABLISHED
// systemEvent is recorded for each.
export async function checkDependenciesOnStartup(
  checks: StartupCheck[] = defaultChecks(),
  exit: (code: number) => never = (code) => process.exit(code),
  logger: Pick<Logger, 'error' | 'log'> = new Logger('Startup'),
  close: () => Promise<void> = closeAll,
  established: (service: SystemService) => void = reportEstablished,
): Promise<void> {
  const results = await Promise.allSettled(
    checks.map((check) => withTimeout(check.probe(), STARTUP_TIMEOUT_MS)),
  );

  const failed = checks.filter((_, i) => results[i].status === 'rejected');
  if (failed.length === 0) {
    logger.log(`Connected to ${listLabels(checks)}`);
    for (const check of checks) {
      established(check.service);
    }
    return;
  }

  checks.forEach((check, i) => {
    const result = results[i];
    if (result.status === 'rejected') {
      const reason = (check.reason ?? connectionErrorReason)(result.reason);
      logger.error(
        `Can't connect to ${check.label} (${check.target}): ${reason}`,
      );
    }
  });
  logger.error(`Exiting: can't reach ${listLabels(failed)}`);

  await close();
  exit(
    Math.min(...failed.map((check) => EXIT_CODES[check.service])),
  );
}

// "a", "a and b", "a, b and c".
function listLabels(checks: StartupCheck[]): string {
  const labels = checks.map((check) => check.label);
  return labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
    : (labels[0] ?? '');
}

// host:port/path, never the user or password.
export function describeTarget(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return 'invalid URL';
  }
}
