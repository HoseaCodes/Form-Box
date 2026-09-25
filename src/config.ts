export interface Config {
  port: number;
  databasePath: string;
  /** Master key for the management API. Required in production. */
  adminApiKey: string;
  /** Public base URL, used in emails and the default "thanks" redirect. */
  publicUrl: string;
  /** Trust X-Forwarded-For for client IPs (set when behind a proxy). */
  trustProxy: boolean;
  /** SMTP connection URL, e.g. smtps://user:pass@smtp.example.com:465. Email is off when empty. */
  smtpUrl: string;
  mailFrom: string;
  /** Max submissions per IP per form per minute. */
  rateLimitPerMinute: number;
  maxBodyBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  return {
    port,
    databasePath: env.DATABASE_PATH ?? "./data/formbox.db",
    adminApiKey: env.ADMIN_API_KEY ?? "",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
    smtpUrl: env.SMTP_URL ?? "",
    mailFrom: env.MAIL_FROM ?? "Formbox <no-reply@localhost>",
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 10),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 100_000),
  };
}
