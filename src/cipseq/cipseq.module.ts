import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller.js';
import { ProjectsController } from './projects.controller.js';

@Module({
  controllers: [ProjectsController, GroupsController],
})
export class CipSeqModule {}
