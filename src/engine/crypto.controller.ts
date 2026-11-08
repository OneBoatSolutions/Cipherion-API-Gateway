import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  deliverEnvelope,
  type EnvelopeDelivery,
} from '../cipseq/envelope-delivery.js';
import { SessionAndCertificate } from './device-certificate.guard.js';

export class EncryptEnvelopeDto {
  @IsUUID()
  groupId!: string;
}

export class DecryptEnvelopeDto extends EncryptEnvelopeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  gdekVersion!: number;
}

const peerOf = (request: FastifyRequest) => {
  if (!request.devicePeer) {
    throw new UnauthorizedException();
  }
  return request.devicePeer;
};

// The only way an envelope leaves the gateway. Both a session and a certificate are
// required, and the device always comes from the certificate, never the request.
@Controller('cipseq/crypto')
export class CryptoController {
  @SessionAndCertificate()
  @HttpCode(200)
  @Post('encrypt')
  encrypt(
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
    @Body() { groupId }: EncryptEnvelopeDto,
  ): Promise<EnvelopeDelivery> {
    return deliverEnvelope({
      peer: peerOf(request),
      userId: user.id,
      groupId,
    });
  }

  @SessionAndCertificate()
  @HttpCode(200)
  @Post('decrypt')
  decrypt(
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
    @Body() { groupId, gdekVersion }: DecryptEnvelopeDto,
  ): Promise<EnvelopeDelivery> {
    return deliverEnvelope({
      peer: peerOf(request),
      userId: user.id,
      groupId,
      gdekVersion,
    });
  }
}
