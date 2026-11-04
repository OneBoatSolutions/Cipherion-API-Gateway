import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Prisma } from '../generated/cipseq/client.js';
import { kmsCall } from '../kms/kms-call.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import {
  findProjectForAdmin,
  findProjectForMember,
  PROJECT_FIELDS,
  toProjectResponse,
} from './project-access.js';
import {
  CreateProjectDto,
  InitializeProjectDto,
  ProjectResponse,
  UpdateProjectDto,
} from './projects.dto.js';

const FIRST_KEY_VERSION = 1;
const logger = new Logger('CipSeq');

// The key is bound to the project id, so a key returned for another project
// must never be saved.
function assertSameProject(sent: string, received: string): void {
  if (sent !== received) {
    logger.error('The KMS returned keys for a different project');
    throw new BadGatewayException();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('cipseq/projects')
export class ProjectsController {
  // The KMS is called outside the transaction, so a slow KMS never holds a
  // database connection. It keeps no state, so a failed write leaves nothing
  // behind and the client can simply try again.
  @ApiOperation({ summary: 'Create a project with the caller as its admin' })
  @ApiCreatedResponse({ type: ProjectResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiServiceUnavailableResponse({ description: 'The KMS is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() { name, description }: CreateProjectDto,
  ): Promise<ProjectResponse> {
    const id = randomUUID();
    const wrapped = await kmsCall('createAndWrapNewProjectRootKey', {
      ProjectId: id,
    });
    assertSameProject(id, wrapped.ProjectId);

    const [project] = await cipseqPrisma.$transaction([
      cipseqPrisma.project.create({
        data: {
          id,
          name,
          description,
          adminUserId: user.id,
          keys: {
            create: {
              wrappedProjectRootKeyIv: wrapped.WrappedProjectRootKeyIV,
              wrappedProjectRootKey: wrapped.WrappedProjectRootKey,
              wrappedProjectRootKeyTag: wrapped.WrappedProjectRootKeyTag,
            },
          },
          members: { create: { userId: user.id } },
        },
        select: PROJECT_FIELDS,
      }),
      auditEvent(user.id, 'project.created', id),
    ]);
    return toProjectResponse(project, user.id);
  }

  // The passphrase goes to the KMS and is then dropped: it is never stored,
  // logged or written to the audit trail.
  @ApiOperation({ summary: "Initialise a project with the admin's passphrase" })
  @ApiOkResponse({ type: ProjectResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project' })
  @ApiConflictResponse({ description: 'Already initialised' })
  @ApiServiceUnavailableResponse({ description: 'The KMS is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @HttpCode(200)
  @Post(':id/initialize')
  async initialize(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() { passphrase }: InitializeProjectDto,
  ): Promise<ProjectResponse> {
    const project = await findProjectForAdmin(id, user.id);
    if (project.keys?.currentKeyVersion != null) {
      throw new ConflictException('The project is already initialised');
    }

    const rootKey = await cipseqPrisma.projectKeys.findUniqueOrThrow({
      where: { projectId: id },
      select: {
        wrappedProjectRootKeyIv: true,
        wrappedProjectRootKey: true,
        wrappedProjectRootKeyTag: true,
      },
    });
    const wrapped = await kmsCall('createAndWrapNewProjectEncryptionKey', {
      ProjectId: id,
      WrappedProjectRootKeyIV: rootKey.wrappedProjectRootKeyIv,
      WrappedProjectRootKey: rootKey.wrappedProjectRootKey,
      WrappedProjectRootKeyTag: rootKey.wrappedProjectRootKeyTag,
      UserPassphrase: passphrase,
    });
    assertSameProject(id, wrapped.ProjectId);

    const encryptionKey = {
      wrappedProjectEncryptionKeyIv: wrapped.WrappedProjectEncryptionKeyIV,
      wrappedProjectEncryptionKey: wrapped.WrappedProjectEncryptionKey,
      wrappedProjectEncryptionKeyTag: wrapped.WrappedProjectEncryptionKeyTag,
      userPassphraseSalt: wrapped.UserPassphraseSalt,
    };

    try {
      await cipseqPrisma.$transaction([
        // The primary key rejects a second initialisation that got this far.
        cipseqPrisma.projectKeyVersion.create({
          data: {
            projectId: id,
            version: FIRST_KEY_VERSION,
            ...rootKey,
            ...encryptionKey,
          },
        }),
        cipseqPrisma.projectKeys.update({
          where: { projectId: id },
          data: { ...encryptionKey, currentKeyVersion: FIRST_KEY_VERSION },
        }),
        auditEvent(user.id, 'project.initialized', id),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('The project is already initialised');
      }
      throw error;
    }

    return toProjectResponse(
      { ...project, keys: { currentKeyVersion: FIRST_KEY_VERSION } },
      user.id,
    );
  }

  @ApiOperation({ summary: "List the signed-in user's projects, newest first" })
  @ApiOkResponse({ type: ProjectResponse, isArray: true })
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<ProjectResponse[]> {
    const projects = await cipseqPrisma.project.findMany({
      where: { deletedAt: null, members: { some: { userId: user.id } } },
      orderBy: { createdAt: 'desc' },
      select: PROJECT_FIELDS,
    });
    return projects.map((project) => toProjectResponse(project, user.id));
  }

  @ApiOperation({ summary: 'Get a project' })
  @ApiOkResponse({ type: ProjectResponse })
  @ApiBadRequestResponse({ description: 'Invalid project id' })
  @ApiNotFoundResponse({ description: 'No such project' })
  @Get(':id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectResponse> {
    const project = await findProjectForMember(id, user.id);
    return toProjectResponse(project, user.id);
  }

  @ApiOperation({ summary: "Update a project's name or description" })
  @ApiOkResponse({ type: ProjectResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project' })
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() { name, description }: UpdateProjectDto,
  ): Promise<ProjectResponse> {
    const project = await findProjectForAdmin(id, user.id);

    // Fields that weren't sent are undefined, which Prisma leaves unchanged.
    const changes = { name, description };
    const changed = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    if (changed.length === 0) {
      return toProjectResponse(project, user.id);
    }

    const [updated] = await cipseqPrisma.$transaction([
      cipseqPrisma.project.update({
        where: { id },
        data: changes,
        select: PROJECT_FIELDS,
      }),
      auditEvent(user.id, 'project.updated', id, { changed }),
    ]);
    return toProjectResponse(updated, user.id);
  }

  // A soft delete: the rows and wrapped keys stay, but the API no longer serves
  // the project.
  @ApiOperation({ summary: 'Delete a project' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'Invalid project id' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project' })
  @HttpCode(204)
  @Delete(':id')
  async delete(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await findProjectForAdmin(id, user.id);

    await cipseqPrisma.$transaction([
      cipseqPrisma.project.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
      auditEvent(user.id, 'project.deleted', id),
    ]);
  }
}
