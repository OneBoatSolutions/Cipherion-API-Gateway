import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isMaster } from '../cipseq/plan-limits.js';

// Runs after the global AuthGuard, so request.user is set. Anyone else gets 404,
// so the route's existence isn't revealed.
@Injectable()
export class MasterGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!user || !isMaster(user)) {
      throw new NotFoundException();
    }
    return true;
  }
}

export const MasterOnly = () => UseGuards(MasterGuard);
