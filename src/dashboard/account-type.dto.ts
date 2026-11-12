import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { AccountType } from '../generated/prisma/enums.js';

export const COMPANY_NAME_MAX_LENGTH = 200;

const ACCOUNT_TYPE_DESCRIPTION =
  'Who holds the account: INDIVIDUAL or COMPANY. null until the user chooses.';
const COMPANY_NAME_DESCRIPTION =
  'The company name for a COMPANY account; null for INDIVIDUAL.';

// The account type as shown in the profile, the settings and the workspace.
export class AccountTypeSummary {
  @ApiProperty({
    enum: AccountType,
    enumName: 'AccountType',
    nullable: true,
    description: ACCOUNT_TYPE_DESCRIPTION,
    example: AccountType.COMPANY,
  })
  accountType!: AccountType | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: COMPANY_NAME_DESCRIPTION,
    example: 'Acme Labs Pvt Ltd',
  })
  companyName!: string | null;
}

export class AccountTypeResponse extends AccountTypeSummary {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the account type was first chosen; null until then',
    example: '2026-11-12T09:30:00.000Z',
  })
  chosenAt!: Date | null;
}

// A company name only belongs to a COMPANY account.
function OnlyForCompany(): PropertyDecorator {
  return ValidateBy({
    name: 'onlyForCompany',
    validator: {
      validate: (value: unknown, args) =>
        value === undefined ||
        (args?.object as { accountType?: unknown } | undefined)?.accountType ===
          AccountType.COMPANY,
      defaultMessage: () =>
        'companyName must be sent only for a COMPANY account',
    },
  });
}

export class SetAccountTypeDto {
  @ApiProperty({
    enum: AccountType,
    enumName: 'AccountType',
    description: 'INDIVIDUAL or COMPANY. Set once; a different type later is refused with 409.',
    example: AccountType.COMPANY,
  })
  @IsEnum(AccountType)
  accountType!: AccountType;

  @ApiProperty({
    required: false,
    maxLength: COMPANY_NAME_MAX_LENGTH,
    description:
      'Required for COMPANY (1–200 characters, trimmed); must not be sent for INDIVIDUAL. Sending the same type again with a new name renames the company.',
    example: 'Acme Labs Pvt Ltd',
  })
  // Runs for a COMPANY account, and for any companyName that was sent, so an
  // INDIVIDUAL account that sends one is refused.
  @ValidateIf(
    (dto: SetAccountTypeDto) =>
      dto.accountType === AccountType.COMPANY || dto.companyName !== undefined,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMPANY_NAME_MAX_LENGTH)
  @OnlyForCompany()
  companyName?: string;
}
