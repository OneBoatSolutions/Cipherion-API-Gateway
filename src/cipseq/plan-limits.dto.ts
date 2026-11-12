import { ApiProperty } from '@nestjs/swagger';

const NULL_FOR_MASTER = 'Null for the master account, which has no limits';

export class PlanUsageResponse {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: NULL_FOR_MASTER,
  })
  max!: number | null;

  @ApiProperty()
  used!: number;
}

export class MonthlyUsageResponse extends PlanUsageResponse {
  @ApiProperty({
    description: 'When the count goes back to 0: the 1st of next month, UTC',
    example: '2026-12-01T00:00:00.000Z',
  })
  resetsAt!: Date;
}

export class PlanLimitsResponse {
  @ApiProperty({
    description: 'True for the master account, which has no limits',
  })
  master!: boolean;

  @ApiProperty({
    type: PlanUsageResponse,
    description: 'Projects you are admin of (deleted ones not counted)',
  })
  projects!: PlanUsageResponse;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: `Groups per project you are admin of. ${NULL_FOR_MASTER}`,
  })
  groupsPerProject!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: `Members besides the project admin plus open invitations, per group of a project you are admin of. ${NULL_FOR_MASTER}`,
  })
  peoplePerGroup!: number | null;

  @ApiProperty({
    type: PlanUsageResponse,
    description: 'Active devices (revoked ones not counted)',
  })
  devices!: PlanUsageResponse;

  @ApiProperty({
    type: MonthlyUsageResponse,
    description:
      'Envelopes delivered to your devices for encryption this month',
  })
  encryptions!: MonthlyUsageResponse;

  @ApiProperty({
    type: MonthlyUsageResponse,
    description:
      'Envelopes delivered to your devices for decryption this month',
  })
  decryptions!: MonthlyUsageResponse;
}
