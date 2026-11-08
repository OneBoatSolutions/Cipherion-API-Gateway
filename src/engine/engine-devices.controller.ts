import { Body, Controller, Post } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { registerDevice } from '../cipseq/device-registration.js';
import { DeviceResponse, RegisterDeviceDto } from '../cipseq/devices.dto.js';

// Registration on the engine listener. DevicesController isn't mounted here,
// because it also holds request-approval and revoke, which have no place on this
// public port.
@Controller('cipseq/devices')
export class EngineDevicesController {
  @Post()
  register(
    @CurrentUser() user: AuthUser,
    @Body() body: RegisterDeviceDto,
  ): Promise<DeviceResponse> {
    return registerDevice(user, body);
  }
}
