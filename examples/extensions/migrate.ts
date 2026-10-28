import "dotenv/config";
import { readFileSync } from "node:fs";
import { prisma } from "../../src/services/prisma.js";

// Operator-only setup for a fresh demo database, after the core migrations.
try {
  const statements = readFileSync(new URL("./schema.sql", import.meta.url), "utf8").split(";").filter(s => s.trim());
  await prisma.$transaction(async db => {
    for (const sql of statements) await db.$executeRawUnsafe(sql);
  });
  console.log("Example product tables created");
} finally { await prisma.$disconnect(); }
