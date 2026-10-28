import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { teamExtension } from "./team.js";
import { apiServiceExtension, exampleEntitlements } from "./api-service.js";

createApp({ extensions: [teamExtension, apiServiceExtension()], entitlements: exampleEntitlements })
  .listen(config.PORT, config.HOST, () => console.log(`Example API listening on ${config.HOST}:${config.PORT}`));
