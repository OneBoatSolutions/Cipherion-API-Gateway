import { ApiProperty } from '@nestjs/swagger';
import { GroupMemberResponse, GroupResponse } from '../cipseq/groups.dto.js';
import { ProjectResponse } from '../cipseq/projects.dto.js';
import { ProfileResponse } from '../dashboard/profile.dto.js';
import { SettingsResponse } from '../dashboard/settings.dto.js';

export class WorkspaceMember extends GroupMemberResponse {
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null if the account no longer exists',
    example: 'Ada Lovelace',
  })
  name!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null if the account no longer exists',
    example: 'ada@cipherion.com',
  })
  email!: string | null;
}

export class WorkspaceGroup extends GroupResponse {
  @ApiProperty({ type: [WorkspaceMember] })
  members!: WorkspaceMember[];
}

export class WorkspaceProject extends ProjectResponse {
  @ApiProperty({
    type: [WorkspaceGroup],
    description:
      'The project admin gets every group, anyone else only the groups they belong to',
  })
  groups!: WorkspaceGroup[];
}

export class WorkspaceResponse {
  @ApiProperty({ type: ProfileResponse })
  profile!: ProfileResponse;

  @ApiProperty({ type: SettingsResponse })
  settings!: SettingsResponse;

  @ApiProperty({ type: [WorkspaceProject] })
  projects!: WorkspaceProject[];

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description:
      'Always empty for now. Invitation, revocation and device requests will appear here',
    example: [],
  })
  notifications!: never[];
}
