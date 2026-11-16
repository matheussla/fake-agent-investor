import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { EventHub } from "./http/sse.js";
import { ensureActiveSimulation } from "./modules/simulations/service.js";
import { startMarketServices } from "./modules/market/service.js";

const config = loadConfig();
const { pool, db } = createDatabase(config.DATABASE_URL);
await ensureActiveSimulation(db);
const events = new EventHub();
const app = buildApp(pool, events);
const { stop: stopMarket } = startMarketServices(pool, events);
app.addHook("onClose", async () => stopMarket());
app.addHook("onClose", async () => pool.end());
await app.listen({ host: config.HOST, port: config.PORT });
