import '../config/env.js';
import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { isDown, reportLost, reportRestored } from './connection-events.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// At most this many emails wait for an SMTP connection; beyond it new ones are
// dropped, so a flood of sign-ups can't grow memory without limit.
export const MAX_PENDING_EMAILS = 200;

const logger = new Logger('Mailer');
const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
const from = process.env.EMAIL_FROM;
const port = Number(EMAIL_PORT);

// Pooled, so a burst reuses two connections instead of opening one per email.
// The timeouts free a connection from a provider that stops answering.
const transport = EMAIL_HOST
  ? createTransport({
      host: EMAIL_HOST,
      port,
      // 465 is TLS from the first byte; other ports upgrade with STARTTLS.
      secure: port === 465,
      // A local catcher such as Mailpit takes no login.
      auth: EMAIL_USER ? { user: EMAIL_USER, pass: EMAIL_PASS } : undefined,
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      // Links in these emails sign people in, so they never travel in clear text.
      requireTLS: process.env.NODE_ENV === 'production',
    })
  : undefined;

// How often the SMTP server is checked, and how long one check may take. Each
// check logs in to the provider, so it's less frequent than the other
// heartbeats; a failed send marks SMTP down at once anyway.
export const SMTP_HEARTBEAT_INTERVAL_MS = 60_000;
export const SMTP_CHECK_TIMEOUT_MS = 10_000;

// nodemailer's codes for "couldn't reach or talk to the server", as opposed to
// an error about one email (a refused recipient, a rejected message).
const CONNECTION_ERROR_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNREFUSED',
  'EDNS',
  'ETLS',
  'EAUTH',
]);

let pending = 0;
// Emails that failed while SMTP was down; reported on the restored line.
let notSentDuringOutage = 0;
let heartbeat: NodeJS.Timeout | undefined;

// The error code only: an SMTP error message can echo the recipient back.
export const errorCode = (error: unknown): string =>
  String(
    (error as { code?: string; responseCode?: number }).code ??
      (error as { responseCode?: number }).responseCode ??
      'unknown',
  );

const isConnectionError = (error: unknown): boolean =>
  CONNECTION_ERROR_CODES.has(errorCode(error));

// Connects, reads the greeting and logs in, without sending anything. Rejects
// with an Error whose message is the nodemailer code.
async function verify(): Promise<void> {
  if (!transport) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      transport.verify(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
          SMTP_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    throw new Error(errorCode(error), { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function checkConnection(): Promise<void> {
  try {
    await verify();
  } catch (error) {
    reportLost('SMTP', (error as Error).message);
    return;
  }
  if (isDown('SMTP')) {
    const count = notSentDuringOutage;
    notSentDuringOutage = 0;
    reportRestored(
      'SMTP',
      count > 0
        ? {
            note: `${count} email${count === 1 ? '' : 's'} not sent during the outage`,
            metadata: { emailsNotSent: count },
          }
        : undefined,
    );
  }
}

// One object, so e2e tests can spy on `send` and read the links.
export const mailer = {
  // Never awaited by a request: it returns at once, and a slow or failing
  // provider can't change a response or reveal whether an account exists.
  // Logs carry the user id, never the address, link or token.
  send: (email: Email, userId: string): void => {
    if (!transport) {
      // Only reachable in tests: the env schema requires EMAIL_HOST elsewhere.
      return;
    }
    if (pending >= MAX_PENDING_EMAILS) {
      logger.error(`Email dropped, too many waiting (user ${userId})`);
      return;
    }

    pending += 1;
    transport
      .sendMail({ from, ...email })
      .catch((error: unknown) => {
        // During an outage the failures are counted, not logged one by one:
        // the outage itself is one line, and the restored line has the count.
        if (isConnectionError(error)) {
          reportLost('SMTP', errorCode(error));
        }
        if (isDown('SMTP')) {
          notSentDuringOutage += 1;
          return;
        }
        logger.error(`Email not sent (user ${userId}): ${errorCode(error)}`);
      })
      .finally(() => {
        pending -= 1;
      });
  },

  // False only in tests, where the env schema allows no EMAIL_HOST.
  enabled: transport !== undefined,

  // For the startup check.
  verify,

  // After startup: checks the server regularly, so an outage is noticed
  // without waiting for an email, and so is the recovery.
  startWatch: (): void => {
    if (!transport || heartbeat) {
      return;
    }
    heartbeat = setInterval(
      () => void checkConnection(),
      SMTP_HEARTBEAT_INTERVAL_MS,
    );
    heartbeat.unref(); // never keeps the process alive on its own
  },

  // For shutdown: stops the heartbeat and closes the pooled connections.
  close: (): void => {
    clearInterval(heartbeat);
    heartbeat = undefined;
    transport?.close();
  },
};
