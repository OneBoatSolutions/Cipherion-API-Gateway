import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller.js';
import { SettingsController } from './settings.controller.js';

@Module({
  controllers: [ProfileController, SettingsController],
})
export class DashboardModule {}
