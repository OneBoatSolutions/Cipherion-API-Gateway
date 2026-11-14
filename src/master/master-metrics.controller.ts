import { Controller, Get, Header } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { MasterMetricsResponse } from './master-metrics.dto.js';
import { readMasterMetrics } from './master-metrics-snapshot.js';
import { MasterOnly } from './master.guard.js';

@ApiTags('master')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@ApiNotFoundResponse({ description: 'Not the master account' })
@MasterOnly()
@Controller('master')
export class MasterMetricsController {
  @ApiOperation({
    summary:
      'Platform-wide counts for today, the last week, month and year, with totals and buckets',
    description:
      'Master account only (`MASTER_EMAILS`). Served from a snapshot refreshed every 6 hours, at 00:00, 06:00, 12:00 and 18:00 UTC, so the counts are at most 6 hours old; `generatedAt` is when the snapshot was taken. All in UTC. `today`: since midnight, 4 buckets of 6 hours. `week`: the last 7 days, one per day. `month`: the last 4 weeks (28 days), one per 7 days. `year`: the last 12 calendar months, one per month. Every bucket is present, the current one is partial, and `totals` is the sum of `series`. Encryptions and decryptions are counted from envelope deliveries.',
  })
  @ApiOkResponse({ type: MasterMetricsResponse })
  @Header('Cache-Control', 'no-store')
  @Get('metrics')
  metrics(): Promise<MasterMetricsResponse> {
    return readMasterMetrics();
  }
}
