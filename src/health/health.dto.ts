import { ApiProperty } from '@nestjs/swagger';

export type CheckStatus = 'up' | 'down';

// Response shapes, declared as classes so Swagger can document them.
export class LivenessResponse {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';
}

export class ReadinessChecks {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database!: CheckStatus;

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  cipseq!: CheckStatus;

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  redis!: CheckStatus;
}

export class ReadinessResponse {
  @ApiProperty({ enum: ['ok', 'error'], example: 'ok' })
  status!: 'ok' | 'error';

  @ApiProperty({ type: ReadinessChecks })
  checks!: ReadinessChecks;
}
