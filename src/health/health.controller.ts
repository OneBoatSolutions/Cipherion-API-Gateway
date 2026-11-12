import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { checkKmsServing } from '../lib/kms.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import {
  CheckStatus,
  LivenessResponse,
  ReadinessResponse,
} from './health.dto.js';

// A dependency that doesn't answer within this time counts as down.
export const CHECK_TIMEOUT_MS = 2000;

@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  // Liveness: the process is running. It never checks dependencies, so a
  // database or Redis outage doesn't get healthy instances restarted.
  @ApiOperation({ summary: 'Liveness probe: the process is running' })
  @ApiOkResponse({ type: LivenessResponse })
  @Get('health')
  health(): LivenessResponse {
    return { status: 'ok' };
  }

  // Readiness: the instance can serve traffic. A 503 tells the load balancer
  // to stop routing requests here until the dependencies are back.
  @ApiOperation({
    summary:
      'Readiness probe: both PostgreSQL databases, Redis and the KMS are reachable',
  })
  @ApiOkResponse({ type: ReadinessResponse })
  @ApiServiceUnavailableResponse({
    type: ReadinessResponse,
    description: 'A dependency is down or slower than 2 seconds',
  })
  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const [database, cipseq, cache, kmsStatus] = await Promise.all([
      check(() => prisma.$queryRaw`SELECT 1`),
      check(() => cipseqPrisma.$queryRaw`SELECT 1`),
      check(() => redis.ping()),
      // Silent: an outage is logged once by the KMS connection watch.
      check(() => checkKmsServing(CHECK_TIMEOUT_MS)),
    ]);

    const checks = { database, cipseq, redis: cache, kms: kmsStatus };
    const response: ReadinessResponse = {
      status: Object.values(checks).every((s) => s === 'up') ? 'ok' : 'error',
      checks,
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
