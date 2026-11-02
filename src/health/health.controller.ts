import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

// A dependency that doesn't answer within this time counts as down.
export const CHECK_TIMEOUT_MS = 2000;

export type CheckStatus = 'up' | 'down';

export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: { database: CheckStatus; redis: CheckStatus };
}

@Public()
@Controller()
export class HealthController {
  // Liveness: the process is running. It never checks dependencies, so a
  // database or Redis outage doesn't get healthy instances restarted.
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: the instance can serve traffic. A 503 tells the load balancer
  // to stop routing requests here until the dependencies are back.
  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const [database, cache] = await Promise.all([
      check(() => prisma.$queryRaw`SELECT 1`),
      check(() => redis.ping()),
    ]);

    const response: ReadinessResponse = {
      status: database === 'up' && cache === 'up' ? 'ok' : 'error',
      checks: { database, redis: cache },
    };

    if (response.status === 'error') {
      throw new ServiceUnavailableException(response);
    }
    return response;
  }
}

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([probe(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
