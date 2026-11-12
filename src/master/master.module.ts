import { Module } from '@nestjs/common';
import { MasterMetricsController } from './master-metrics.controller.js';

// Routes for the master account only (MASTER_EMAILS), each behind @MasterOnly().
@Module({
  controllers: [MasterMetricsController],
})
export class MasterModule {}
