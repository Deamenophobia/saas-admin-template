// Lifted from kokoro-pipeline/console/server/src/services/prisma.ts on 2026-05-12 by the kokoro-account extraction pass.
//
// Template adaptation: standard PostgreSQL connection; no accelerator coupling.

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
