-- A COMPANY account has a company name and an INDIVIDUAL account has none.
-- The API enforces this too; the CHECK keeps it true for rows support edits
-- by hand. Prisma's schema can't express it, so it's written here.
ALTER TABLE "accountProfile"
  ADD CONSTRAINT "accountProfile_companyName_matches_type"
  CHECK (("accountType" = 'COMPANY') = ("companyName" IS NOT NULL));
