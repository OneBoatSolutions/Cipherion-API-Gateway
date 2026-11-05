import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller.js';

@Module({
  controllers: [WorkspaceController],
})
export class WorkspaceModule {}
