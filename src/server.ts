import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { DefaultNotifier } from "./notify.js";

const config = loadConfig();

if (!config.adminApiKey || config.adminApiKey.length < 24) {
  console.error("ADMIN_API_KEY must be set (at least 24 chars). Generate one with:\n  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"");
  process.exit(1);
}

const store = new Store(config.databasePath);
const notifier = new DefaultNotifier(store, config);
const app = createApp({ store, config, notifier });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`formbox listening on :${info.port}  (public URL ${config.publicUrl})`);
  if (!config.smtpUrl) console.log("SMTP_URL not set — email notifications are off.");
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
