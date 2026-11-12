-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateTable
CREATE TABLE "accountProfile" (
    "userId" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "companyName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accountProfile_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "accountProfile" ADD CONSTRAINT "accountProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
