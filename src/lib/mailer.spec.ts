import { Logger } from '@nestjs/common';

const sendMail = vi.fn();
const close = vi.fn();
const verify = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, close, verify }));
vi.mock('nodemailer', () => ({ createTransport }));

// Outage state, as connection-events.ts keeps it, without logging or writing.
const events = vi.hoisted(() => {
  const down = new Set<string>();
  return {
    down,
    isDown: vi.fn((service: string) => down.has(service)),
    reportLost: vi.fn((service: string) => down.add(service)),
    reportRestored: vi.fn((service: string) => down.delete(service)),
  };
});
vi.mock('./connection-events.js', () => events);

const email = {
  to: 'ada@cipherion.test',
  subject: 'Verify your Cipherion email address',
  text: 'link: http://localhost/verify-email?token=secret-token',
  html: '<a href="http://localhost/verify-email?token=secret-token">x</a>',
};

const MAILPIT = { EMAIL_HOST: 'localhost', EMAIL_PORT: '1025' };

// The transport is created when the module loads, from the env at that time.
// Unset values are stubbed empty, not removed: env.ts would load a removed one
// again from .env.dev.
async function loadMailer(env: Record<string, string>) {
  vi.resetModules();
  for (const name of ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASS']) {
    vi.stubEnv(name, env[name] ?? '');
  }
  vi.stubEnv('EMAIL_FROM', 'Cipherion <no-reply@cipherion.test>');
  return import('./mailer.js');
}

describe('mailer', () => {
  let logError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendMail.mockReset();
    verify.mockReset().mockResolvedValue(true);
    createTransport.mockClear();
    events.down.clear();
    events.reportLost.mockClear();
    events.reportRestored.mockClear();
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    logError.mockRestore();
  });

  it('uses a pooled transport with timeouts, and no login for Mailpit', async () => {
    await loadMailer(MAILPIT);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'localhost',
        port: 1025,
        secure: false,
        auth: undefined,
        pool: true,
        maxConnections: 2,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      }),
    );
  });

  it.each([
    ['465', true],
    ['587', false],
  ])(
    'logs in, with TLS from the start only on port %s',
    async (port, secure) => {
      await loadMailer({
        EMAIL_HOST: 'smtp.example.com',
        EMAIL_PORT: port,
        EMAIL_USER: 'mailer@example.com',
        EMAIL_PASS: 'p@ss:w/rd#1',
      });
      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: Number(port),
          secure,
          auth: { user: 'mailer@example.com', pass: 'p@ss:w/rd#1' },
        }),
      );
    },
  );

  it('sends without making the caller wait', async () => {
    let finish: () => void = () => {};
    sendMail.mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve)),
    );
    const { mailer } = await loadMailer(MAILPIT);

    expect(mailer.send(email, 'user-1')).toBeUndefined();
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Cipherion <no-reply@cipherion.test>',
      ...email,
    });
    finish();
  });

  it('logs only the user id and error code on failure', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error(`550 rejected ${email.to} ${email.text}`), {
        responseCode: 550,
      }),
    );
    const { mailer } = await loadMailer(MAILPIT);

    mailer.send(email, 'user-1');
    await vi.waitFor(() => expect(logError).toHaveBeenCalled());

    const logged = logError.mock.calls.flat().join(' ');
    expect(logged).toBe('Email not sent (user user-1): 550');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain(email.to);
  });

  it('drops emails beyond the waiting limit', async () => {
    sendMail.mockReturnValue(new Promise(() => {}));
    const { mailer, MAX_PENDING_EMAILS } = await loadMailer(MAILPIT);

    for (let i = 0; i <= MAX_PENDING_EMAILS; i++) {
      mailer.send(email, `user-${i}`);
    }

    expect(sendMail).toHaveBeenCalledTimes(MAX_PENDING_EMAILS);
    expect(logError).toHaveBeenCalledWith(
      `Email dropped, too many waiting (user user-${MAX_PENDING_EMAILS})`,
    );
  });

  it('sends nothing without EMAIL_HOST, which only tests allow', async () => {
    const { mailer } = await loadMailer({});
    mailer.send(email, 'user-1');
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(mailer.enabled).toBe(false);
  });

  describe('SMTP connection', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNECTION',
    });

    afterEach(async () => {
      const { mailer } = await import('./mailer.js');
      mailer.close();
      vi.useRealTimers();
    });

    it('verifies the server for the startup check, rejecting with the code only', async () => {
      const { mailer } = await loadMailer(MAILPIT);
      await expect(mailer.verify()).resolves.toBeUndefined();

      verify.mockRejectedValue(refused);
      await expect(mailer.verify()).rejects.toThrow(/^ECONNECTION$/);
    });

    it('reports a failed send that means the server is down, and counts later failures instead of logging them', async () => {
      sendMail.mockRejectedValue(refused);
      const { mailer } = await loadMailer(MAILPIT);

      mailer.send(email, 'user-1');
      mailer.send(email, 'user-2');
      await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.reportLost).toHaveBeenCalledWith('SMTP', 'ECONNECTION');
      expect(logError).not.toHaveBeenCalled();
    });

    it('checks the server regularly and reports the recovery with the count', async () => {
      vi.useFakeTimers();
      const { mailer, SMTP_HEARTBEAT_INTERVAL_MS } = await loadMailer(MAILPIT);
      mailer.startWatch();

      verify.mockRejectedValue(refused);
      await vi.advanceTimersByTimeAsync(SMTP_HEARTBEAT_INTERVAL_MS);
      expect(events.reportLost).toHaveBeenCalledWith('SMTP', 'ECONNECTION');

      sendMail.mockRejectedValue(refused);
      for (const id of ['user-1', 'user-2', 'user-3']) {
        mailer.send(email, id);
      }
      await vi.advanceTimersByTimeAsync(0);

      verify.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SMTP_HEARTBEAT_INTERVAL_MS);

      expect(events.reportRestored).toHaveBeenCalledWith('SMTP', {
        note: '3 emails not sent during the outage',
        metadata: { emailsNotSent: 3 },
      });
      expect(logError).not.toHaveBeenCalled();
    });

    it('stays quiet while the server is up', async () => {
      vi.useFakeTimers();
      const { mailer, SMTP_HEARTBEAT_INTERVAL_MS } = await loadMailer(MAILPIT);
      mailer.startWatch();

      await vi.advanceTimersByTimeAsync(SMTP_HEARTBEAT_INTERVAL_MS * 3);

      expect(verify).toHaveBeenCalledTimes(3);
      expect(events.reportLost).not.toHaveBeenCalled();
      expect(events.reportRestored).not.toHaveBeenCalled();
    });
  });
});
