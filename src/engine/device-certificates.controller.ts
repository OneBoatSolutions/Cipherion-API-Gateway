import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  type CertificateResponse,
  issueCertificate,
} from '../cipseq/device-certificate-issuance.js';
import { DEVICE_ID_PATTERN } from '../cipseq/devices.dto.js';
import { CertificateOnly } from './device-certificate.guard.js';
import { assertDeviceRequestLimit } from './engine-limits.js';

// Only mounted on the engine listener, so enrolment can't happen over the console
// port. The body isn't a DTO: issueCertificate() parses it itself, so that a bad CSR
// from a known device still counts against its limit.
@Controller('cipseq/devices/:deviceId/certificate')
export class DeviceCertificatesController {
  // Session only. Never @Public().
  @Post()
  async enrol(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CertificateResponse> {
    // The same answer as an unknown device.
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new NotFoundException();
    }
    await assertDeviceRequestLimit(deviceId);
    const result = await issueCertificate({
      operation: 'ENROL',
      deviceId,
      actorId: user.id,
      body,
    });
    void reply.code(result.status);
    return result.certificate;
  }

  // Certificate only: the engine renews on its own, without its owner signed in.
  @CertificateOnly()
  @Post('renew')
  async renew(
    @Req() request: FastifyRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CertificateResponse> {
    if (!request.devicePeer) {
      throw new UnauthorizedException();
    }
    const result = await issueCertificate({
      operation: 'RENEW',
      deviceId,
      peer: request.devicePeer,
      body,
    });
    void reply.code(result.status);
    return result.certificate;
  }
}
