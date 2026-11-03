// Prisma config for the CipSeq database. The auth database uses
// prisma7.config.ts; every Prisma command must name one of the two.
import { defineConfig } from "prisma/config";
import dotenv from 'dotenv';

const nodeEnv = process.env.NODE_ENV ?? 'development';

const envFile =
  nodeEnv === 'production'
    ? '.env.prod'
    : nodeEnv === 'test'
      ? '.env.test'
      : '.env.dev';

dotenv.config({ path: envFile });

export default defineConfig({
  schema: "prisma/cipseq/schema.prisma",
  migrations: {
    path: "prisma/cipseq/migrations",
  },
  datasource: {
    url: process.env["CIPSEQ_DATABASE_URL"],
  },
});
