import '../config/env.js';
import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';

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

let pending = 0;

// The error code only: an SMTP error message can echo the recipient back.
const errorCode = (error: unknown) =>
  (error as { code?: string; responseCode?: number }).code ??
  (error as { responseCode?: number }).responseCode ??
  'unknown';

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
        logger.error(`Email not sent (user ${userId}): ${errorCode(error)}`);
      })
      .finally(() => {
        pending -= 1;
      });
  },

  // For shutdown: closes the pooled connections.
  close: (): void => {
    transport?.close();
  },
};
