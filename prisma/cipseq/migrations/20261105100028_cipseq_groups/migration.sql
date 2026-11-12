-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "group" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groupKeys" (
    "groupId" UUID NOT NULL,
    "wrappedGroupRootKeyIv" TEXT NOT NULL,
    "wrappedGroupRootKey" TEXT NOT NULL,
    "wrappedGroupRootKeyTag" TEXT NOT NULL,
    "wrappedGroupDataEncryptionKeyIv" TEXT NOT NULL,
    "wrappedGroupDataEncryptionKey" TEXT NOT NULL,
    "wrappedGroupDataEncryptionKeyTag" TEXT NOT NULL,
    "currentGdekVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groupKeys_pkey" PRIMARY KEY ("groupId")
);

-- CreateTable
CREATE TABLE "groupKeyVersion" (
    "groupId" UUID NOT NULL,
    "gdekVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groupKeyVersion_pkey" PRIMARY KEY ("groupId","gdekVersion")
);

-- CreateTable
CREATE TABLE "groupMember" (
    "groupId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE INDEX "group_projectId_idx" ON "group"("projectId");

-- CreateIndex
CREATE INDEX "groupMember_userId_idx" ON "groupMember"("userId");

-- AddForeignKey
ALTER TABLE "group" ADD CONSTRAINT "group_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groupKeys" ADD CONSTRAINT "groupKeys_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groupKeyVersion" ADD CONSTRAINT "groupKeyVersion_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groupMember" ADD CONSTRAINT "groupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
