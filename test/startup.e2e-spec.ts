import { execFileSync, spawn } from 'node:child_process';
import { EXIT_CODES } from './../src/lib/startup-checks.js';

// Starts the built gateway the way it runs in production (node dist/main.js),
// with one dependency pointed at a port nothing listens on, and checks that it
// refuses to start with that dependency's exit code. Everything else comes
// from .env.dev, so the other dependencies must be running, as for any e2e test.
const DEAD_PORT = '1';

function startGateway(
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: { ...process.env, NODE_ENV: 'development', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    // It must give up on its own (5 s startup timeout); this is a backstop.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`still running after 20 s:\n${output}`));
    }, 20_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('Startup checks (e2e)', () => {
  beforeAll(() => {
    // Built from this checkout, so the test runs the code under test.
    execFileSync(process.execPath, ['node_modules/@nestjs/cli/bin/nest.js', 'build'], {
      stdio: 'ignore',
    });
  }, 180_000);

  // SMTP always points at a dead local port here, so the tests never log in to
  // the real mail provider in .env.dev.
  const deadSmtp = { EMAIL_HOST: 'localhost', EMAIL_PORT: DEAD_PORT };

  it('exits with 14 when the SMTP server is unreachable, and says why', async () => {
    const { code, output } = await startGateway(deadSmtp);

    expect(code).toBe(EXIT_CODES.SMTP);
    // nodemailer's code for a refused port (ESOCKET or ECONNECTION).
    expect(output).toMatch(
      new RegExp(
        `Can't connect to the SMTP server \\(localhost:${DEAD_PORT}\\): E[A-Z]+`,
      ),
    );
    expect(output).toContain("Exiting: can't reach the SMTP server");
    expect(output).not.toContain('Application is running');
  }, 30_000);

  it('logs every unreachable dependency and exits with the first one’s code', async () => {
    const { code, output } = await startGateway({
      ...deadSmtp,
      // rediss://, so REDIS_CA_CERT from .env.dev stays valid.
      REDIS_URL: `rediss://localhost:${DEAD_PORT}`,
    });

    expect(code).toBe(EXIT_CODES.REDIS);
    expect(output).toContain(
      `Can't connect to Redis (localhost:${DEAD_PORT}): ECONNREFUSED`,
    );
    expect(output).toContain(`Can't connect to the SMTP server`);
    expect(output).toContain("Exiting: can't reach Redis and the SMTP server");
    // Only the startup check reports it: no "Connection lost" line as well.
    expect(output).not.toContain('Connection lost');
  }, 30_000);
});
