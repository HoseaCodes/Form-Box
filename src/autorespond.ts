import type { Config } from "./config.js";
import type { Form, Submission } from "./db.js";

/**
 * Sends one confirmation email back to whoever filled in the form, by calling
 * an external transactional email API.
 *
 * Exactly one attempt, deliberately. The email service this talks to does not
 * implement idempotency, and a request that times out may already have sent,
 * so a retry risks delivering the same message twice. A missed autoresponse is
 * the cheaper failure, especially where the form's success page already gives
 * the visitor whatever the email links to.
 *
 * This is separate from the webhook in notify.ts, which does retry: a webhook
 * goes to a system you control and can make idempotent, an email does not.
 */
export async function sendAutoresponse(
  config: Config,
  form: Form,
  submission: Submission,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const template = config.autorespond[form.id];
  if (!template) return;
  if (!config.emailApiUrl || !config.emailApiKey) {
    throw new Error("autoresponse configured for this form but EMAIL_API_URL / EMAIL_API_KEY are not set");
  }

  const recipient = submission.data[template.field ?? "email"];
  if (typeof recipient !== "string" || !recipient.includes("@")) return;

  const res = await fetchImpl(config.emailApiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.emailApiKey,
    },
    body: JSON.stringify({
      to: [{ email: recipient }],
      subject: template.subject,
      textContent: template.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`email API responded ${res.status}`);
  }
}
