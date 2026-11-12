-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projectKeys" (
    "projectId" UUID NOT NULL,
    "wrappedProjectRootKeyIv" TEXT NOT NULL,
    "wrappedProjectRootKey" TEXT NOT NULL,
    "wrappedProjectRootKeyTag" TEXT NOT NULL,
    "wrappedProjectEncryptionKeyIv" TEXT,
    "wrappedProjectEncryptionKey" TEXT,
    "wrappedProjectEncryptionKeyTag" TEXT,
    "userPassphraseSalt" TEXT,
    "currentKeyVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projectKeys_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "projectKeyVersion" (
    "projectId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "wrappedProjectRootKeyIv" TEXT NOT NULL,
    "wrappedProjectRootKey" TEXT NOT NULL,
    "wrappedProjectRootKeyTag" TEXT NOT NULL,
    "wrappedProjectEncryptionKeyIv" TEXT NOT NULL,
    "wrappedProjectEncryptionKey" TEXT NOT NULL,
    "wrappedProjectEncryptionKeyTag" TEXT NOT NULL,
    "userPassphraseSalt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projectKeyVersion_pkey" PRIMARY KEY ("projectId","version")
);

-- CreateTable
CREATE TABLE "projectMember" (
    "projectId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projectMember_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "auditEvent" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "projectId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projectMember_userId_idx" ON "projectMember"("userId");

-- CreateIndex
CREATE INDEX "auditEvent_userId_createdAt_idx" ON "auditEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "auditEvent_projectId_createdAt_idx" ON "auditEvent"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "projectKeys" ADD CONSTRAINT "projectKeys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projectKeyVersion" ADD CONSTRAINT "projectKeyVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projectMember" ADD CONSTRAINT "projectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
