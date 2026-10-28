// Explicit operator action; no public endpoint can grant platform-administrator access.
import "../src/config.js";
import { prisma } from "../src/services/prisma.js";
import { emailSchema } from "../src/http.js";
const email = emailSchema.parse(process.argv[2]);
try {
  const user = await prisma.$transaction(async db => {
    const result = await db.user.update({ where: { email }, data: { isSuperAdmin: true }, select: { id: true } });
    await db.auditLog.create({ data: { action: "operator.platform_admin_granted", resourceId: result.id } });
    return result;
  });
  console.log(`Granted platform administrator to user ${user.id}`);
} finally { await prisma.$disconnect(); }
