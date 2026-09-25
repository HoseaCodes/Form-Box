import { createHmac } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";
import type { Form, Store, Submission } from "./db.js";

export interface Notifier {
  onSubmission(form: Form, submission: Submission, extras: { subject?: string; replyTo?: string }): void;
  /** Re-send only the webhook (no email). */
  redeliverWebhook(form: Form, submission: Submission): void;
}

/**
 * Signature scheme (verify on your side):
 *   header X-Formbox-Timestamp: unix seconds
 *   header X-Formbox-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 * Reject if the timestamp is more than ~5 minutes old.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DefaultNotifier implements Notifier {
  private transport: Transporter | null;

  constructor(
    private store: Store,
    private config: Config,
    private fetchImpl: typeof fetch = fetch,
    private retryDelaysMs: number[] = [0, 2_000, 10_000, 60_000],
  ) {
    this.transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  }

  onSubmission(form: Form, submission: Submission, extras: { subject?: string; replyTo?: string }) {
    if (submission.spam) return;
    if (form.webhookUrl && form.webhookSecret) {
      void this.deliverWebhook(form, submission).catch((e) => console.error("[webhook]", e));
    }
    if (this.transport && form.notifyEmails.length) {
      void this.sendEmail(form, submission, extras).catch((e) => console.error("[email]", e));
    }
  }

  redeliverWebhook(form: Form, submission: Submission) {
    void this.deliverWebhook(form, submission).catch((e) => console.error("[webhook]", e));
  }

  async deliverWebhook(form: Form, submission: Submission): Promise<boolean> {
    const body = JSON.stringify({
      event: "submission.created",
      form: { id: form.id, name: form.name },
      submission: { id: submission.id, data: submission.data, createdAt: submission.createdAt },
    });
    let attempt = 0;
    for (const delay of this.retryDelaysMs) {
      if (delay) await sleep(delay);
      attempt++;
      const ts = Math.floor(Date.now() / 1000);
      try {
        const res = await this.fetchImpl(form.webhookUrl!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "formbox-webhook/1",
            "x-formbox-event": "submission.created",
            "x-formbox-delivery": submission.id,
            "x-formbox-timestamp": String(ts),
            "x-formbox-signature": signPayload(form.webhookSecret!, ts, body),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.store.setWebhookResult(submission.id, "delivered", attempt);
          return true;
        }
        // 4xx other than 408/429 won't get better on retry.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch {
        // network error / timeout → retry
      }
      this.store.setWebhookResult(submission.id, "pending", attempt);
    }
    this.store.setWebhookResult(submission.id, "failed", attempt);
    return false;
  }

  private async sendEmail(form: Form, submission: Submission, extras: { subject?: string; replyTo?: string }) {
    const lines = Object.entries(submission.data).map(
      ([k, v]) => `${k}:\n  ${typeof v === "string" ? v : JSON.stringify(v)}`,
    );
    await this.transport!.sendMail({
      from: this.config.mailFrom,
      to: form.notifyEmails,
      replyTo: extras.replyTo,
      subject: extras.subject || `New submission: ${form.name}`,
      text: `${lines.join("\n\n")}\n\n—\nForm ${form.id} · Submission ${submission.id} · ${submission.createdAt}`,
    });
  }
}
