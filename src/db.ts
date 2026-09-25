import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formId, secretKey, submissionId } from "./ids.js";

export interface Form {
  id: string;
  name: string;
  /** Exact origins allowed to post (e.g. "https://myapp.com"). Empty = any origin. */
  allowedOrigins: string[];
  /** Where plain HTML form posts are sent after submit (overridable per-post with _next). */
  redirectUrl: string | null;
  notifyEmails: string[];
  webhookUrl: string | null;
  webhookSecret: string | null;
  /** Hidden field name; if filled in, the submission is treated as spam. */
  honeypotField: string;
  /** Optional list of required field names. */
  requiredFields: string[];
  enabled: boolean;
  /** Per-form API key: lets one app read only its own form's submissions. */
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  id: string;
  formId: string;
  data: Record<string, unknown>;
  meta: { ip?: string; userAgent?: string; referer?: string; origin?: string };
  spam: boolean;
  webhookStatus: "none" | "pending" | "delivered" | "failed";
  webhookAttempts: number;
  createdAt: string;
}

type FormRow = {
  id: string; name: string; allowed_origins: string; redirect_url: string | null;
  notify_emails: string; webhook_url: string | null; webhook_secret: string | null;
  honeypot_field: string; required_fields: string; enabled: number; api_key: string;
  created_at: string; updated_at: string;
};
type SubmissionRow = {
  id: string; form_id: string; data: string; meta: string; spam: number;
  webhook_status: Submission["webhookStatus"]; webhook_attempts: number; created_at: string;
};

const toForm = (r: FormRow): Form => ({
  id: r.id,
  name: r.name,
  allowedOrigins: JSON.parse(r.allowed_origins),
  redirectUrl: r.redirect_url,
  notifyEmails: JSON.parse(r.notify_emails),
  webhookUrl: r.webhook_url,
  webhookSecret: r.webhook_secret,
  honeypotField: r.honeypot_field,
  requiredFields: JSON.parse(r.required_fields),
  enabled: r.enabled === 1,
  apiKey: r.api_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSubmission = (r: SubmissionRow): Submission => ({
  id: r.id,
  formId: r.form_id,
  data: JSON.parse(r.data),
  meta: JSON.parse(r.meta),
  spam: r.spam === 1,
  webhookStatus: r.webhook_status,
  webhookAttempts: r.webhook_attempts,
  createdAt: r.created_at,
});

export type FormInput = Partial<
  Pick<Form, "name" | "allowedOrigins" | "redirectUrl" | "notifyEmails" | "webhookUrl" |
    "honeypotField" | "requiredFields" | "enabled">
>;

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        allowed_origins TEXT NOT NULL DEFAULT '[]',
        redirect_url TEXT,
        notify_emails TEXT NOT NULL DEFAULT '[]',
        webhook_url TEXT,
        webhook_secret TEXT,
        honeypot_field TEXT NOT NULL DEFAULT '_gotcha',
        required_fields TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        api_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        meta TEXT NOT NULL,
        spam INTEGER NOT NULL DEFAULT 0,
        webhook_status TEXT NOT NULL DEFAULT 'none',
        webhook_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_form ON submissions(form_id, id);
    `);
  }

  // ---- forms ----

  createForm(input: FormInput & { name: string }): Form {
    const now = new Date().toISOString();
    const id = formId();
    this.db
      .prepare(
        `INSERT INTO forms (id, name, allowed_origins, redirect_url, notify_emails, webhook_url,
           webhook_secret, honeypot_field, required_fields, enabled, api_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.allowedOrigins ?? []),
        input.redirectUrl ?? null,
        JSON.stringify(input.notifyEmails ?? []),
        input.webhookUrl ?? null,
        input.webhookUrl ? secretKey("whsec") : null,
        input.honeypotField ?? "_gotcha",
        JSON.stringify(input.requiredFields ?? []),
        input.enabled === false ? 0 : 1,
        secretKey("fk"),
        now,
        now,
      );
    return this.getForm(id)!;
  }

  getForm(id: string): Form | null {
    const row = this.db.prepare(`SELECT * FROM forms WHERE id = ?`).get(id) as FormRow | undefined;
    return row ? toForm(row) : null;
  }

  getFormByApiKey(key: string): Form | null {
    const row = this.db.prepare(`SELECT * FROM forms WHERE api_key = ?`).get(key) as FormRow | undefined;
    return row ? toForm(row) : null;
  }

  listForms(): Form[] {
    return (this.db.prepare(`SELECT * FROM forms ORDER BY created_at DESC`).all() as FormRow[]).map(toForm);
  }

  updateForm(id: string, input: FormInput): Form | null {
    const current = this.getForm(id);
    if (!current) return null;
    const next = { ...current, ...input };
    // Mint a webhook secret the first time a webhook URL is set.
    const webhookSecret = next.webhookUrl ? current.webhookSecret ?? secretKey("whsec") : null;
    this.db
      .prepare(
        `UPDATE forms SET name = ?, allowed_origins = ?, redirect_url = ?, notify_emails = ?,
           webhook_url = ?, webhook_secret = ?, honeypot_field = ?, required_fields = ?, enabled = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        JSON.stringify(next.allowedOrigins),
        next.redirectUrl,
        JSON.stringify(next.notifyEmails),
        next.webhookUrl,
        webhookSecret,
        next.honeypotField,
        JSON.stringify(next.requiredFields),
        next.enabled ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.getForm(id);
  }

  rotateFormKey(id: string, which: "api" | "webhook"): Form | null {
    const col = which === "api" ? "api_key" : "webhook_secret";
    const val = which === "api" ? secretKey("fk") : secretKey("whsec");
    const res = this.db.prepare(`UPDATE forms SET ${col} = ?, updated_at = ? WHERE id = ?`)
      .run(val, new Date().toISOString(), id);
    return res.changes ? this.getForm(id) : null;
  }

  deleteForm(id: string): boolean {
    return this.db.prepare(`DELETE FROM forms WHERE id = ?`).run(id).changes > 0;
  }

  // ---- submissions ----

  createSubmission(
    formId: string,
    data: Record<string, unknown>,
    meta: Submission["meta"],
    opts: { spam: boolean; webhookPending: boolean },
  ): Submission {
    const id = submissionId();
    this.db
      .prepare(
        `INSERT INTO submissions (id, form_id, data, meta, spam, webhook_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        formId,
        JSON.stringify(data),
        JSON.stringify(meta),
        opts.spam ? 1 : 0,
        opts.webhookPending ? "pending" : "none",
        new Date().toISOString(),
      );
    return this.getSubmission(id)!;
  }

  getSubmission(id: string): Submission | null {
    const row = this.db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(id) as SubmissionRow | undefined;
    return row ? toSubmission(row) : null;
  }

  /**
   * Newest first. `before` / `after` are submission ids used as cursors.
   * `spam`: "exclude" (default), "only", or "include".
   */
  listSubmissions(
    formId: string,
    opts: { limit?: number; before?: string; after?: string; spam?: "exclude" | "only" | "include" } = {},
  ): { items: Submission[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where = ["form_id = ?"];
    const params: unknown[] = [formId];
    if (opts.before) { where.push("id < ?"); params.push(opts.before); }
    if (opts.after) { where.push("id > ?"); params.push(opts.after); }
    const spam = opts.spam ?? "exclude";
    if (spam === "exclude") where.push("spam = 0");
    if (spam === "only") where.push("spam = 1");
    const rows = this.db
      .prepare(`SELECT * FROM submissions WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as SubmissionRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toSubmission);
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  countSubmissions(formId: string): { total: number; spam: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(spam), 0) AS spam FROM submissions WHERE form_id = ?`)
      .get(formId) as { total: number; spam: number };
    return r;
  }

  setSpam(id: string, spam: boolean): Submission | null {
    this.db.prepare(`UPDATE submissions SET spam = ? WHERE id = ?`).run(spam ? 1 : 0, id);
    return this.getSubmission(id);
  }

  setWebhookResult(id: string, status: Submission["webhookStatus"], attempts: number) {
    this.db.prepare(`UPDATE submissions SET webhook_status = ?, webhook_attempts = ? WHERE id = ?`)
      .run(status, attempts, id);
  }

  deleteSubmission(id: string): boolean {
    return this.db.prepare(`DELETE FROM submissions WHERE id = ?`).run(id).changes > 0;
  }

  close() {
    this.db.close();
  }
}
