/** A confirmation email sent back to the person who submitted the form. */
export interface AutorespondTemplate {
  subject: string;
  text: string;
  /** Submission field holding the recipient address. Defaults to "email". */
  field?: string;
}

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
  /** Transactional email API used for autoresponses. Off when empty. */
  emailApiUrl: string;
  emailApiKey: string;
  /** Autoresponse templates keyed by form id. Forms not listed send nothing. */
  autorespond: Record<string, AutorespondTemplate>;
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
    emailApiUrl: env.EMAIL_API_URL ?? "",
    emailApiKey: env.EMAIL_API_KEY ?? "",
    autorespond: parseAutorespond(env.AUTORESPOND),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 10),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 100_000),
  };
}

/** AUTORESPOND is JSON: {"<formId>":{"subject":"...","text":"...","field":"email"}}.
    Malformed JSON disables autoresponses rather than stopping the server, since
    form capture matters more than the confirmation email. */
function parseAutorespond(raw: string | undefined): Record<string, AutorespondTemplate> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, AutorespondTemplate>;
  } catch (e) {
    console.error("[config] AUTORESPOND is not valid JSON, autoresponses disabled:", e);
    return {};
  }
}
