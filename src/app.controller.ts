import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service.js';
import { Public } from './auth/decorators/public.decorator.js';

@ApiTags('gateway')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @ApiOperation({ summary: 'Greeting' })
  @ApiOkResponse({
    schema: { type: 'string', example: 'Hello Cipherion :)' },
  })
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
