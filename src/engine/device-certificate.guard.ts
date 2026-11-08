import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators/public.decorator.js';
import { authorizeRequest } from '../cipseq/device-certificates.js';
import { devicePeer } from './device-peer.js';
import { assertDeviceRequestLimit } from './engine-limits.js';

type DeviceAccess = 'certificate' | 'session-certificate';
const DEVICE_ACCESS = 'deviceAccess';

// Runs after the global AuthGuard. The certificate check is re-done against the
// database on every request, including on a keep-alive or resumed TLS connection.
@Injectable()
export class DeviceCertificateGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.get<DeviceAccess | undefined>(
      DEVICE_ACCESS,
      context.getHandler(),
    );
    if (!access) {
      throw new ForbiddenException();
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const peer = devicePeer(request);
    await assertDeviceRequestLimit(peer.deviceId);

    let actorId: string | undefined;
    if (access === 'session-certificate') {
      if (!request.user) {
        throw new UnauthorizedException();
      }
      actorId = request.user.id;
    }
    await authorizeRequest(peer, actorId);
    request.devicePeer = peer;
    return true;
  }
}

// Renewal: a certificate and no session. Wrapped so that @Public() can never appear
// here without the certificate check, which would be an open issuing endpoint.
export const CertificateOnly = () =>
  applyDecorators(
    Public(),
    SetMetadata(DEVICE_ACCESS, 'certificate' satisfies DeviceAccess),
    UseGuards(DeviceCertificateGuard),
  );

// Crypto: a session AND a certificate.
export const SessionAndCertificate = () =>
  applyDecorators(
    SetMetadata(DEVICE_ACCESS, 'session-certificate' satisfies DeviceAccess),
    UseGuards(DeviceCertificateGuard),
  );
