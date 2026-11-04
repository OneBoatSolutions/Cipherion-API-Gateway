import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Metadata } from '@grpc/grpc-js';
import { Public } from '../auth/decorators/public.decorator.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { HealthCheckResponse_ServingStatus } from '../generated/kms/grpc/health/v1/health.js';
import { kmsHealth } from '../lib/kms.js';
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
      check(() => kmsServing()),
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

const kmsLogger = new Logger('KMS');
let kmsDown = false;

// grpc.health.v1 Check on the whole KMS server (empty service name). Only
// SERVING counts as up; NOT_SERVING or an error rejects. The reason is logged
// once when the KMS goes down and once when it is back, not on every probe.
function kmsServing(): Promise<void> {
  return new Promise((resolve, reject) => {
    kmsHealth.check(
      { service: '' },
      new Metadata(),
      { deadline: Date.now() + CHECK_TIMEOUT_MS },
      (error, response) => {
        const failure = error
          ? error.message
          : response.status !== HealthCheckResponse_ServingStatus.SERVING
            ? `health check answered ${HealthCheckResponse_ServingStatus[response.status] ?? response.status}`
            : null;

        if (failure) {
          if (!kmsDown) {
            kmsDown = true;
            kmsLogger.warn(`Readiness check failed: ${failure}`);
          }
          reject(new Error(failure));
        } else {
          if (kmsDown) {
            kmsDown = false;
            kmsLogger.log('Readiness check passing again');
          }
          resolve();
        }
      },
    );
  });
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
