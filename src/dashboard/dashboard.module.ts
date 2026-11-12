import { Module } from '@nestjs/common';
import { AccountTypeController } from './account-type.controller.js';
import { ProfileController } from './profile.controller.js';
import { SettingsController } from './settings.controller.js';

@Module({
  controllers: [ProfileController, SettingsController, AccountTypeController],
})
export class DashboardModule {}
