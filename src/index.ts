import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./services/prisma.js";
const server = createApp().listen(config.PORT, config.HOST, () => {
  console.log(`API listening on ${config.HOST}:${config.PORT}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close(() => { void prisma.$disconnect().then(() => process.exit(0)); });
});
