import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  LEADERBOARD_PERIODS,
  type LeaderboardPeriod,
  USAGE_PERIODS,
  type UsagePeriod,
} from './metrics.js';

export const USAGE_SCOPES = ['project', 'group', 'user', 'device'] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

const DEVICE_ID = /^dvc_[A-Za-z0-9_-]{43}$/;
// Better Auth ids: UUID v4 today, and older random ids until they're migrated.
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ID_FORMATS: Record<UsageScope, { pattern: RegExp; message: string }> = {
  project: { pattern: UUID, message: 'id must be a project id (UUID)' },
  group: { pattern: UUID, message: 'id must be a group id (UUID)' },
  user: { pattern: USER_ID, message: 'id must be a user id' },
  device: { pattern: DEVICE_ID, message: 'id must be a device id (dvc_…)' },
};

// The id's format depends on the scope. An unknown scope is reported by its own
// validator, so it isn't repeated here.
@ValidatorConstraint({ name: 'idForScope' })
class IdForScope implements ValidatorConstraintInterface {
  validate(id: unknown, { object }: ValidationArguments): boolean {
    const format = ID_FORMATS[(object as UsageQuery).scope];
    return !format || (typeof id === 'string' && format.pattern.test(id));
  }

  defaultMessage({ object }: ValidationArguments): string {
    return ID_FORMATS[(object as UsageQuery).scope].message;
  }
}

// ---------- Query parameters ----------

export class LeaderboardQuery {
  @IsOptional()
  @IsIn(LEADERBOARD_PERIODS)
  period?: LeaderboardPeriod;
}

export class UsageQuery {
  @IsIn(USAGE_SCOPES)
  scope!: UsageScope;

  @IsString()
  @Validate(IdForScope)
  id!: string;

  @IsIn(USAGE_PERIODS)
  period!: UsagePeriod;
}

// ---------- Responses ----------

export class MetricsTotals {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Envelopes delivered for encryption',
    example: 42,
  })
  encryptions!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Envelopes delivered for decryption',
    example: 17,
  })
  decryptions!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '`encryptions + decryptions`',
    example: 59,
  })
  total!: number;
}

export class MetricsBucket extends MetricsTotals {
  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'Start of the bucket, inclusive, in UTC',
    example: '2026-11-11T06:00:00.000Z',
  })
  start!: Date;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description:
      'End of the bucket, exclusive, in UTC. The current bucket ends in the future and only counts up to now',
    example: '2026-11-11T12:00:00.000Z',
  })
  end!: Date;
}

export class LeaderboardProject extends MetricsTotals {
  @ApiProperty({
    format: 'uuid',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  projectId!: string;

  @ApiProperty({ example: 'Payments' })
  name!: string;
}

export class LeaderboardUser extends MetricsTotals {
  @ApiProperty({
    description: 'Better Auth user id',
    example: '3b241101-e2bb-4255-8caf-4136c566a962',
  })
  userId!: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null if the account no longer exists',
    example: 'Ada Lovelace',
  })
  name!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null if the account no longer exists',
    example: 'ada@cipherion.com',
  })
  email!: string | null;
}

export class LeaderboardDevice extends MetricsTotals {
  @ApiProperty({ example: 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
  deviceId!: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'The name its owner gave it, if any',
    example: 'Work laptop',
  })
  name!: string | null;

  @ApiProperty({
    enum: ['ACTIVE', 'REVOKED'],
    description:
      'REVOKED devices still appear: their deliveries happened before the revoke',
    example: 'ACTIVE',
  })
  status!: 'ACTIVE' | 'REVOKED';

  @ApiProperty({
    description: "The device owner's Better Auth user id",
    example: '3b241101-e2bb-4255-8caf-4136c566a962',
  })
  userId!: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: "The owner's name. Null if the account no longer exists",
    example: 'Ada Lovelace',
  })
  userName!: string | null;
}

class MetricsWindow {
  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'Start of the first bucket, in UTC',
    example: '2026-11-11T00:00:00.000Z',
  })
  from!: Date;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description:
      'End of the last bucket, in UTC. It can be in the future: the current bucket is partial',
    example: '2026-11-12T00:00:00.000Z',
  })
  to!: Date;

  @ApiProperty({
    type: MetricsTotals,
    description: 'Sum of every bucket in `series`',
  })
  totals!: MetricsTotals;

  @ApiProperty({
    type: [MetricsBucket],
    description:
      'Oldest first. Every bucket is present, with zeros where nothing happened, so it can be plotted directly',
  })
  series!: MetricsBucket[];
}

export class LeaderboardResponse extends MetricsWindow {
  @ApiProperty({ enum: LEADERBOARD_PERIODS, example: 'month' })
  period!: LeaderboardPeriod;

  @ApiProperty({
    type: [LeaderboardProject],
    description: 'Up to 10, highest total first',
  })
  projects!: LeaderboardProject[];

  @ApiProperty({
    type: [LeaderboardUser],
    description: 'Up to 10, highest total first',
  })
  users!: LeaderboardUser[];

  @ApiProperty({
    type: [LeaderboardDevice],
    description: 'Up to 10, highest total first',
  })
  devices!: LeaderboardDevice[];
}

export class UsageResponse extends MetricsWindow {
  @ApiProperty({ enum: USAGE_SCOPES, example: 'device' })
  scope!: UsageScope;

  @ApiProperty({
    description: 'The id that was asked for',
    example: 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  id!: string;

  @ApiProperty({ enum: USAGE_PERIODS, example: 'today' })
  period!: UsagePeriod;
}
