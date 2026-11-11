import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller.js';
import { GroupsController } from './groups.controller.js';
import { InvitationResponsesController } from './invitation-responses.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { MetricsController } from './metrics.controller.js';
import { ProjectDevicesController } from './project-devices.controller.js';
import { ProjectsController } from './projects.controller.js';

@Module({
  controllers: [
    ProjectsController,
    GroupsController,
    InvitationsController,
    InvitationResponsesController,
    DevicesController,
    ProjectDevicesController,
    MetricsController,
  ],
})
export class CipSeqModule {}
