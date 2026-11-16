import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { EventHub } from "./http/sse.js";

const config = loadConfig();
const { pool } = createDatabase(config.DATABASE_URL);
const app = buildApp(pool, new EventHub());
app.addHook("onClose", async () => pool.end());
await app.listen({ host: config.HOST, port: config.PORT });
