import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Form, Store, Submission } from "./db.js";
import type { Notifier } from "./notify.js";

const LIMITS = { maxFields: 100, maxKeyLength: 100, maxValueLength: 10_000 };

// ---------------------------------------------------------------------------
// helpers

class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 413 | 415 | 422 | 429, public code: string, message: string) {
    super(message);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#f6f6f4;color:#1b1b1b}
main{max-width:28rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}a{color:inherit}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

/** Simple fixed-window rate limiter kept in memory (per process). */
class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();
  constructor(private limit: number, private windowMs = 60_000) {}
  take(key: string, now = Date.now()): boolean {
    if (this.hits.size > 50_000) this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

// ---------------------------------------------------------------------------
// validation for the management API

const originSchema = z.string().refine((s) => originOf(s) === s.replace(/\/$/, ""), {
  message: "must be an origin like https://example.com",
}).transform((s) => s.replace(/\/$/, ""));
const httpUrl = z.string().url().refine((s) => originOf(s) !== null, { message: "must be http(s)" });

const formCreateSchema = z.object({
  name: z.string().min(1).max(200),
  allowedOrigins: z.array(originSchema).max(50).optional(),
  redirectUrl: httpUrl.nullable().optional(),
  notifyEmails: z.array(z.string().email()).max(20).optional(),
  webhookUrl: httpUrl.nullable().optional(),
  honeypotField: z.string().min(1).max(100).optional(),
  requiredFields: z.array(z.string().min(1).max(LIMITS.maxKeyLength)).max(LIMITS.maxFields).optional(),
  enabled: z.boolean().optional(),
});
const formUpdateSchema = formCreateSchema.partial();

// ---------------------------------------------------------------------------

type Principal = { kind: "admin" } | { kind: "form"; formId: string };
type Env = { Variables: { principal: Principal } };

/** What a per-form key (i.e. a consuming app) is allowed to see about its form. */
const publicForm = (f: Form) => ({
  id: f.id,
  name: f.name,
  allowedOrigins: f.allowedOrigins,
  honeypotField: f.honeypotField,
  requiredFields: f.requiredFields,
  enabled: f.enabled,
  createdAt: f.createdAt,
});

export function createApp(deps: { store: Store; config: Config; notifier: Notifier }) {
  const { store, config, notifier } = deps;
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const app = new Hono<Env>();

  const clientIp = (c: Context) => {
    if (config.trustProxy) {
      // Use the last hop: that's the one our proxy appended. Earlier entries come from the client and can be forged.
      const xff = c.req.header("x-forwarded-for");
      if (xff) return xff.split(",").at(-1)!.trim();
    }
    // @hono/node-server exposes the raw socket via c.env.incoming
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return incoming?.socket?.remoteAddress ?? "unknown";
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: "invalid_request", message: "Validation failed", issues: err.issues } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/thanks", (c) =>
    c.html(page("Thanks!", `<p>Your submission was received.</p>${
      originOf(c.req.header("referer")) ? `<p><a href="${escapeHtml(c.req.header("referer")!)}">← Go back</a></p>` : ""
    }`)),
  );

  // -------------------------------------------------------------------------
  // Public submission endpoint:  POST /f/:formId

  const submitCors = cors({
    origin: (origin, c) => {
      const form = store.getForm(c.req.param("formId") ?? "");
      if (!form) return null;
      if (!form.allowedOrigins.length) return origin || "*";
      return form.allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept"],
    maxAge: 600,
  });
  app.use("/f/:formId", submitCors);

  app.post("/f/:formId", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const isJsonBody = contentType.includes("application/json");
    const wantsJson = isJsonBody || (c.req.header("accept") ?? "").includes("application/json");

    const fail = (status: HttpError["status"], code: string, message: string) => {
      if (wantsJson) return c.json({ ok: false, error: { code, message } }, status);
      return c.html(page("Submission failed", `<p>${escapeHtml(message)}</p><p><a href="javascript:history.back()">← Go back</a></p>`), status);
    };

    const form = store.getForm(c.req.param("formId"));
    if (!form) return fail(404, "form_not_found", "This form does not exist.");
    if (!form.enabled) return fail(403, "form_disabled", "This form is not accepting submissions.");

    const origin = originOf(c.req.header("origin")) ?? originOf(c.req.header("referer"));
    // No Origin/Referer = server-to-server post; allowed. Browsers always send one of these on cross-site POSTs.
    if (form.allowedOrigins.length && origin && !form.allowedOrigins.includes(origin)) {
      return fail(403, "origin_not_allowed", "Submissions from this site are not allowed.");
    }

    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (declaredLength > config.maxBodyBytes) return fail(413, "payload_too_large", "Submission is too large.");

    if (!limiter.take(`${form.id}:${clientIp(c)}`)) {
      return fail(429, "rate_limited", "Too many submissions. Please try again in a minute.");
    }

    // ---- parse body
    let raw: Record<string, unknown>;
    try {
      if (isJsonBody) {
        const text = await c.req.text();
        if (Buffer.byteLength(text) > config.maxBodyBytes) return fail(413, "payload_too_large", "Submission is too large.");
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return fail(400, "invalid_body", "JSON body must be an object.");
        }
        raw = parsed;
      } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody({ all: true });
        raw = {};
        for (const [k, v] of Object.entries(body)) {
          const values = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string"); // file uploads are dropped
          if (values.length) raw[k] = values.length === 1 ? values[0] : values;
        }
      } else {
        return fail(415, "unsupported_media_type", "Send JSON, urlencoded, or multipart form data.");
      }
    } catch {
      return fail(400, "invalid_body", "Could not parse the submission body.");
    }

    // ---- split control fields (prefixed "_") from data
    const honeypotValue = raw[form.honeypotField];
    const next = typeof raw._next === "string" ? raw._next : undefined;
    const subject = typeof raw._subject === "string" ? raw._subject.slice(0, 200) : undefined;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_") || k === form.honeypotField) continue;
      data[k] = v;
    }

    // ---- validate
    const keys = Object.keys(data);
    if (!keys.length) return fail(422, "empty_submission", "The submission has no fields.");
    if (keys.length > LIMITS.maxFields) return fail(422, "too_many_fields", `At most ${LIMITS.maxFields} fields are allowed.`);
    for (const k of keys) {
      if (k.length > LIMITS.maxKeyLength) return fail(422, "invalid_field", `Field name "${k.slice(0, 40)}…" is too long.`);
      const size = typeof data[k] === "string" ? (data[k] as string).length : JSON.stringify(data[k]).length;
      if (size > LIMITS.maxValueLength) return fail(422, "invalid_field", `Field "${k}" is too long.`);
    }
    const missing = form.requiredFields.filter((f) => {
      const v = data[f];
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    });
    if (missing.length) return fail(422, "missing_fields", `Missing required field(s): ${missing.join(", ")}`);

    const replyToCandidate = [raw._replyto, data.email].find((v) => typeof v === "string" && /^\S+@\S+\.\S+$/.test(v));
    const spam = typeof honeypotValue === "string" ? honeypotValue.trim() !== "" : honeypotValue != null;

    const submission = store.createSubmission(
      form.id,
      data,
      {
        ip: clientIp(c),
        userAgent: c.req.header("user-agent")?.slice(0, 500),
        referer: c.req.header("referer")?.slice(0, 500),
        origin: origin ?? undefined,
      },
      { spam, webhookPending: !spam && !!form.webhookUrl },
    );
    notifier.onSubmission(form, submission, { subject, replyTo: replyToCandidate as string | undefined });

    // ---- respond (bots that trip the honeypot get the same success response)
    if (wantsJson) return c.json({ ok: true, id: submission.id }, 201);

    // Only redirect to _next if it's on an allowed origin (prevents open redirects).
    const nextOrigin = originOf(next);
    const nextAllowed = next && nextOrigin && (form.allowedOrigins.length
      ? form.allowedOrigins.includes(nextOrigin)
      : origin === nextOrigin);
    const target = (nextAllowed ? next : null) ?? form.redirectUrl ?? `${config.publicUrl}/thanks`;
    return c.redirect(target, 303);
  });

  // -------------------------------------------------------------------------
  // Management API:  /api/*   (Authorization: Bearer <admin key | form key>)

  app.use("/api/*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PATCH", "DELETE"] }));

  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token) throw new HttpError(401, "unauthorized", "Missing bearer token.");
    if (config.adminApiKey && safeEqual(token, config.adminApiKey)) {
      c.set("principal", { kind: "admin" });
    } else {
      const form = token.startsWith("fk_") ? store.getFormByApiKey(token) : null;
      if (!form) throw new HttpError(401, "unauthorized", "Invalid API key.");
      c.set("principal", { kind: "form", formId: form.id });
    }
    return next();
  });

  const requireAdmin = (c: Context<Env>) => {
    if (c.get("principal").kind !== "admin") throw new HttpError(403, "forbidden", "This action needs the admin key.");
  };
  /** Loads a form the caller may access (admin: any; form key: only its own). */
  const accessibleForm = (c: Context<Env>, id: string): Form => {
    const p = c.get("principal");
    if (p.kind === "form" && p.formId !== id) throw new HttpError(404, "not_found", "Form not found.");
    const form = store.getForm(id);
    if (!form) throw new HttpError(404, "not_found", "Form not found.");
    return form;
  };
  const accessibleSubmission = (c: Context<Env>, id: string): Submission => {
    const s = store.getSubmission(id);
    if (!s) throw new HttpError(404, "not_found", "Submission not found.");
    accessibleForm(c, s.formId);
    return s;
  };
  const endpointFor = (f: Form) => `${config.publicUrl}/f/${f.id}`;
  const serializeForm = (c: Context<Env>, f: Form) =>
    c.get("principal").kind === "admin"
      ? { ...f, endpoint: endpointFor(f), counts: store.countSubmissions(f.id) }
      : { ...publicForm(f), endpoint: endpointFor(f), counts: store.countSubmissions(f.id) };

  const jsonBody = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      throw new HttpError(400, "invalid_body", "Body must be valid JSON.");
    }
  };

  // Who am I? Handy for apps holding a form key.
  app.get("/api/me", (c) => {
    const p = c.get("principal");
    return c.json(p.kind === "admin" ? { kind: "admin" } : { kind: "form", form: serializeForm(c, store.getForm(p.formId)!) });
  });

  // ---- forms
  app.get("/api/forms", (c) => {
    requireAdmin(c);
    return c.json({ items: store.listForms().map((f) => serializeForm(c, f)) });
  });

  app.post("/api/forms", async (c) => {
    requireAdmin(c);
    const input = formCreateSchema.parse(await jsonBody(c));
    return c.json(serializeForm(c, store.createForm(input)), 201);
  });

  app.get("/api/forms/:id", (c) => c.json(serializeForm(c, accessibleForm(c, c.req.param("id")))));

  app.patch("/api/forms/:id", async (c) => {
    requireAdmin(c);
    const input = formUpdateSchema.parse(await jsonBody(c));
    const form = store.updateForm(c.req.param("id"), input);
    if (!form) throw new HttpError(404, "not_found", "Form not found.");
    return c.json(serializeForm(c, form));
  });

  app.delete("/api/forms/:id", (c) => {
    requireAdmin(c);
    if (!store.deleteForm(c.req.param("id"))) throw new HttpError(404, "not_found", "Form not found.");
    return c.body(null, 204);
  });

  app.post("/api/forms/:id/rotate-key", async (c) => {
    requireAdmin(c);
    const { which } = z.object({ which: z.enum(["api", "webhook"]) }).parse(await jsonBody(c));
    const form = store.rotateFormKey(c.req.param("id"), which);
    if (!form) throw new HttpError(404, "not_found", "Form not found.");
    return c.json(serializeForm(c, form));
  });

  // ---- submissions
  const listQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    spam: z.enum(["exclude", "only", "include"]).optional(),
  });

  app.get("/api/forms/:id/submissions", (c) => {
    const form = accessibleForm(c, c.req.param("id"));
    const q = listQuery.parse(c.req.query());
    return c.json(store.listSubmissions(form.id, q));
  });

  app.get("/api/forms/:id/submissions.csv", (c) => {
    const form = accessibleForm(c, c.req.param("id"));
    const spam = listQuery.shape.spam.parse(c.req.query("spam"));
    const all: Submission[] = [];
    let cursor: string | undefined;
    do {
      const page = store.listSubmissions(form.id, { limit: 500, before: cursor, spam });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const fields = [...new Set(all.flatMap((s) => Object.keys(s.data)))];
    const cell = (v: unknown) => {
      let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // defuse spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      ["id", "created_at", ...fields].map(cell).join(","),
      ...all.map((s) => [s.id, s.createdAt, ...fields.map((f) => s.data[f])].map(cell).join(",")),
    ];
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${form.id}-submissions.csv"`);
    return c.body(rows.join("\r\n") + "\r\n");
  });

  app.get("/api/submissions/:id", (c) => c.json(accessibleSubmission(c, c.req.param("id"))));

  app.patch("/api/submissions/:id", async (c) => {
    const s = accessibleSubmission(c, c.req.param("id"));
    const { spam } = z.object({ spam: z.boolean() }).parse(await jsonBody(c));
    return c.json(store.setSpam(s.id, spam));
  });

  app.delete("/api/submissions/:id", (c) => {
    const s = accessibleSubmission(c, c.req.param("id"));
    store.deleteSubmission(s.id);
    return c.body(null, 204);
  });

  app.post("/api/submissions/:id/redeliver", (c) => {
    requireAdmin(c);
    const s = accessibleSubmission(c, c.req.param("id"));
    const form = store.getForm(s.formId)!;
    if (!form.webhookUrl) throw new HttpError(422, "no_webhook", "This form has no webhook configured.");
    store.setWebhookResult(s.id, "pending", s.webhookAttempts);
    notifier.redeliverWebhook(form, s);
    return c.json({ ok: true }, 202);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found." } }, 404));

  return app;
}
