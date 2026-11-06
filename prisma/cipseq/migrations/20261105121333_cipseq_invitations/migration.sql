-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING_APPROVAL', 'REJECTED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RemovalRequestStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "groupInvitation" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "inviteeEmail" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groupInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groupMemberRemovalRequest" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "RemovalRequestStatus" NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groupMemberRemovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "groupInvitation_inviteeEmail_status_idx" ON "groupInvitation"("inviteeEmail", "status");

-- CreateIndex
CREATE INDEX "groupInvitation_groupId_status_idx" ON "groupInvitation"("groupId", "status");

-- CreateIndex
CREATE INDEX "groupMemberRemovalRequest_groupId_status_idx" ON "groupMemberRemovalRequest"("groupId", "status");

-- AddForeignKey
ALTER TABLE "groupInvitation" ADD CONSTRAINT "groupInvitation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groupMemberRemovalRequest" ADD CONSTRAINT "groupMemberRemovalRequest_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Written by hand: Prisma's schema can't express partial unique indexes.
-- One open invitation per group and email.
CREATE UNIQUE INDEX "groupInvitation_one_open" ON "groupInvitation"("groupId", "inviteeEmail")
  WHERE "status" IN ('PENDING_APPROVAL', 'PENDING_ACCEPTANCE');

-- One pending removal request per group and member.
CREATE UNIQUE INDEX "groupMemberRemovalRequest_one_pending" ON "groupMemberRemovalRequest"("groupId", "targetUserId")
  WHERE "status" = 'PENDING_APPROVAL';
