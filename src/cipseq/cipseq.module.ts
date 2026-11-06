import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller.js';
import { InvitationResponsesController } from './invitation-responses.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { ProjectsController } from './projects.controller.js';
import { RemovalRequestsController } from './removal-requests.controller.js';

@Module({
  controllers: [
    ProjectsController,
    GroupsController,
    InvitationsController,
    InvitationResponsesController,
    RemovalRequestsController,
  ],
})
export class CipSeqModule {}
