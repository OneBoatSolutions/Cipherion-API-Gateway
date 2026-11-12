import { ApiProperty } from '@nestjs/swagger';

export class MasterMetricsCounts {
  @ApiProperty({ description: 'Envelopes delivered for encryption' })
  encryptions!: number;

  @ApiProperty({ description: 'Envelopes delivered for decryption' })
  decryptions!: number;

  @ApiProperty({ description: 'Accounts signed up' })
  accountsCreated!: number;

  @ApiProperty({
    description:
      'Accounts deleted. Always 0 until deleting an account is possible',
  })
  accountsDeleted!: number;

  @ApiProperty({
    description: 'Projects created, including ones deleted since',
  })
  projectsCreated!: number;

  @ApiProperty({ description: 'Projects deleted' })
  projectsDeleted!: number;

  @ApiProperty({ description: 'Groups created, including ones deleted since' })
  groupsCreated!: number;

  @ApiProperty({ description: 'Groups deleted' })
  groupsDeleted!: number;

  @ApiProperty({
    description: 'Devices registered, including ones revoked since',
  })
  devicesRegistered!: number;

  @ApiProperty({
    description:
      'Members revoked from a group or from a whole project (one per revocation)',
  })
  membersRevoked!: number;

  @ApiProperty({
    description:
      'Devices revoked from a group, from a project, or everywhere by their user (one per revocation)',
  })
  devicesRevoked!: number;
}

export class MasterMetricsBucket extends MasterMetricsCounts {
  @ApiProperty({ example: '2026-11-12T00:00:00.000Z' })
  start!: Date;

  @ApiProperty({
    description: 'Exclusive. The current bucket is partial',
    example: '2026-11-12T06:00:00.000Z',
  })
  end!: Date;
}

export class MasterMetricsPeriod {
  @ApiProperty({ description: 'Start of the first bucket (UTC)' })
  start!: Date;

  @ApiProperty({ description: 'End of the last bucket (UTC), exclusive' })
  end!: Date;

  @ApiProperty({
    type: MasterMetricsCounts,
    description: 'The sum of `series`',
  })
  totals!: MasterMetricsCounts;

  @ApiProperty({
    type: [MasterMetricsBucket],
    description: 'Oldest first. Every bucket is present, empty ones as 0',
  })
  series!: MasterMetricsBucket[];
}

export class MasterMetricsPeriods {
  @ApiProperty({
    type: MasterMetricsPeriod,
    description: 'Since UTC midnight, in 4 buckets of 6 hours',
  })
  today!: MasterMetricsPeriod;

  @ApiProperty({
    type: MasterMetricsPeriod,
    description: 'The last 7 days including today, one bucket per day',
  })
  week!: MasterMetricsPeriod;

  @ApiProperty({
    type: MasterMetricsPeriod,
    description:
      'The last 4 weeks (28 days) including today, one bucket per 7 days',
  })
  month!: MasterMetricsPeriod;

  @ApiProperty({
    type: MasterMetricsPeriod,
    description:
      'The last 12 calendar months including this one, one bucket per month',
  })
  year!: MasterMetricsPeriod;
}

export class MasterMetricsResponse {
  @ApiProperty({ example: '2026-11-12T10:15:00.000Z' })
  generatedAt!: Date;

  @ApiProperty({ type: MasterMetricsPeriods })
  periods!: MasterMetricsPeriods;
}
