import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  ACCOUNT_TYPE_CHANGE_REFUSED,
  loadAccountType,
  setAccountType,
} from './account-type.js';
import { AccountTypeResponse, SetAccountTypeDto } from './account-type.dto.js';
import { RateLimit } from '../lib/rate-limit.guard.js';

const SET_ONCE = [
  'The type is set once. Sending the same type again succeeds, and for a',
  'COMPANY account renames the company. A different type answers `409`;',
  'support changes it by hand. A company name is required for COMPANY and',
  'refused for INDIVIDUAL.',
].join(' ');

@ApiTags('dashboard')
@ApiCookieAuth()
@ApiUnauthorizedResponse({
  description: 'No valid session',
  example: { statusCode: 401, message: 'Unauthorized' },
})
@Controller('dashboard/account-type')
export class AccountTypeController {
  @ApiOperation({
    summary: "Get the signed-in user's account type",
    description:
      'INDIVIDUAL or COMPANY, used later to choose a subscription tier. Every field is `null` until the user chooses.',
  })
  @ApiOkResponse({
    type: AccountTypeResponse,
    examples: {
      notChosen: {
        summary: 'Not chosen yet',
        value: { accountType: null, companyName: null, chosenAt: null },
      },
      individual: {
        summary: 'Individual',
        value: {
          accountType: 'INDIVIDUAL',
          companyName: null,
          chosenAt: '2026-11-12T09:30:00.000Z',
        },
      },
      company: {
        summary: 'Company',
        value: {
          accountType: 'COMPANY',
          companyName: 'Acme Labs Pvt Ltd',
          chosenAt: '2026-11-12T09:30:00.000Z',
        },
      },
    },
  })
  @Get()
  get(@CurrentUser() user: AuthUser): Promise<AccountTypeResponse> {
    return loadAccountType(user.id);
  }

  @ApiOperation({
    summary: "Choose the signed-in user's account type",
    description: SET_ONCE,
  })
  @ApiBody({
    type: SetAccountTypeDto,
    examples: {
      individual: { summary: 'Individual', value: { accountType: 'INDIVIDUAL' } },
      company: {
        summary: 'Company',
        value: { accountType: 'COMPANY', companyName: 'Acme Labs Pvt Ltd' },
      },
    },
  })
  @ApiOkResponse({ type: AccountTypeResponse })
  @ApiBadRequestResponse({
    description:
      'Validation failed: an unknown type, a missing or empty company name for COMPANY, or a company name for INDIVIDUAL',
    example: {
      message: 'Validation failed',
      errors: [
        {
          property: 'companyName',
          constraints: ['companyName should not be empty'],
        },
      ],
    },
  })
  @ApiConflictResponse({
    description: 'A different account type is already set',
    example: {
      statusCode: 409,
      message: ACCOUNT_TYPE_CHANGE_REFUSED,
      error: 'Conflict',
    },
  })
  @HttpCode(200)
  @RateLimit()
  @Put()
  set(
    @CurrentUser() user: AuthUser,
    @Body() body: SetAccountTypeDto,
  ): Promise<AccountTypeResponse> {
    return setAccountType(user.id, body);
  }
}
