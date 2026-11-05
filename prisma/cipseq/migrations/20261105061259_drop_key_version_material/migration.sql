/*
  Warnings:

  - You are about to drop the column `userPassphraseSalt` on the `projectKeyVersion` table. All the data in the column will be lost.
  - You are about to drop the column `wrappedProjectEncryptionKey` on the `projectKeyVersion` table. All the data in the column will be lost.
  - You are about to drop the column `wrappedProjectEncryptionKeyIv` on the `projectKeyVersion` table. All the data in the column will be lost.
  - You are about to drop the column `wrappedProjectEncryptionKeyTag` on the `projectKeyVersion` table. All the data in the column will be lost.
  - You are about to drop the column `wrappedProjectRootKey` on the `projectKeyVersion` table. All the data in the column will be lost.
  - You are about to drop the column `wrappedProjectRootKeyIv` on the `projectKeyVersion` table. All the data in the column will be lost.
  - You are about to drop the column `wrappedProjectRootKeyTag` on the `projectKeyVersion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "projectKeyVersion" DROP COLUMN "userPassphraseSalt",
DROP COLUMN "wrappedProjectEncryptionKey",
DROP COLUMN "wrappedProjectEncryptionKeyIv",
DROP COLUMN "wrappedProjectEncryptionKeyTag",
DROP COLUMN "wrappedProjectRootKey",
DROP COLUMN "wrappedProjectRootKeyIv",
DROP COLUMN "wrappedProjectRootKeyTag";
