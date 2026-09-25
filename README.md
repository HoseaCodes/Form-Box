# Formbox

A tiny self-hosted Formspree-style form backend. Point any HTML form or `fetch()` call at it, and your other apps read submissions over a small REST API or receive them by signed webhook.

- **Stack:** Node 22+, TypeScript, [Hono](https://hono.dev), SQLite (better-sqlite3). One process, one database file.
- **Accepts:** JSON, `application/x-www-form-urlencoded`, and `multipart/form-data` (file fields are dropped).
- **Protection:** per-form origin allow-list and CORS, honeypot spam field, per-IP rate limit, size and field limits, required fields, no open redirects.
- **Delivery:** REST API with cursor pagination, CSV export, HMAC-signed webhooks with retries, and optional SMTP email.
- **Keys:** one admin key for everything, plus a per-form `fk_…` key so each app can read only its own form.

## Run it

```bash
npm install
cp .env.example .env         # set ADMIN_API_KEY (node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
npm run dev                  # or: npm run build && npm start
npm test
```

With Docker: `docker compose up -d --build`. The data lives in the `formbox-data` volume.

Behind a proxy (Fly, Render, Railway, nginx), set `PUBLIC_URL` to the public https URL and `TRUST_PROXY=true`.

## Create a form

```bash
curl -X POST $FORMBOX/api/forms \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "HYSC contact",
    "allowedOrigins": ["https://yoursite.com"],
    "requiredFields": ["email"],
    "redirectUrl": "https://yoursite.com/thanks",
    "notifyEmails": ["you@yourdomain.com"],
    "webhookUrl": "https://yourapp.com/hooks/formbox"
  }'
```

The response includes `endpoint` (where the form posts), `apiKey` (`fk_…`, a read key scoped to this form), and `webhookSecret` (`whsec_…`) when a webhook is set. Every field except `name` is optional. Leave `allowedOrigins` empty to accept posts from any site.

## Submit

**Plain HTML** (no JS; the browser is redirected after posting):

```html
<form action="https://forms.yourdomain.com/f/f_abc123" method="POST">
  <input name="email" type="email" required>
  <textarea name="message"></textarea>
  <input type="hidden" name="_subject" value="New contact message">
  <input type="hidden" name="_next" value="https://yoursite.com/thanks">
  <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">
  <button>Send</button>
</form>
```

**fetch / any backend:**

```js
await fetch("https://forms.yourdomain.com/f/f_abc123", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, message }),
}); // 201 → { ok: true, id: "s_…" }
```

Fields starting with `_` are control fields and are not stored:

| Field | Effect |
|---|---|
| `_next` | Redirect after an HTML post. It is only honored when it points to an allowed origin, or to the posting site if no allow-list is set. |
| `_subject` | Subject line for the notification email |
| `_replyto` | Reply-To for the email (falls back to an `email` field) |
| `_gotcha` | Honeypot (the name can be changed per form). If it's filled in, the submission is stored as spam, the bot still gets a normal success response, and no notifications go out. |

Errors come back as JSON `{ ok: false, error: { code, message } }` when you post JSON or send `Accept: application/json`, and as a small HTML page otherwise. The codes are `form_not_found`, `form_disabled`, `origin_not_allowed`, `rate_limited`, `payload_too_large`, `missing_fields`, `empty_submission`, `too_many_fields`, `invalid_field`, `invalid_body`, and `unsupported_media_type`.

## Consume from your apps

Every request uses `Authorization: Bearer <key>`. The admin key can do everything. A form key (`fk_…`) can only read or manage submissions for its own form. Keep keys on the server side.

| Method & path | Who | Notes |
|---|---|---|
| `GET /api/me` | any | Shows which principal the key maps to |
| `GET /api/forms` | admin | |
| `POST /api/forms` | admin | |
| `GET /api/forms/:id` | admin, own form key | Form keys don't see secrets |
| `PATCH /api/forms/:id` | admin | Partial update |
| `DELETE /api/forms/:id` | admin | Also deletes its submissions |
| `POST /api/forms/:id/rotate-key` | admin | `{ "which": "api" \| "webhook" }` |
| `GET /api/forms/:id/submissions` | admin, own form key | `?limit=50&before=<id>&after=<id>&spam=exclude\|only\|include`, newest first. Returns `{ items, nextCursor }` |
| `GET /api/forms/:id/submissions.csv` | admin, own form key | |
| `GET /api/submissions/:id` | admin, own form key | |
| `PATCH /api/submissions/:id` | admin, own form key | `{ "spam": true }` |
| `DELETE /api/submissions/:id` | admin, own form key | |
| `POST /api/submissions/:id/redeliver` | admin | Re-sends the webhook |

Submission IDs sort by time, so to poll for anything new, pass the newest ID you've already seen as `?after=`.

### Drop-in client

`client/formbox-client.js` is a single dependency-free file that works in the browser and in Node 18+:

```js
import { submitForm, FormboxClient, verifyWebhook } from "./formbox-client.js";

await submitForm(FORMBOX_URL, "f_abc123", { email, message });   // or pass a <form> element

const fb = new FormboxClient(FORMBOX_URL, process.env.FORMBOX_KEY);
const { items, nextCursor } = await fb.listSubmissions("f_abc123", { limit: 20 });
for await (const s of fb.allSubmissions("f_abc123")) { /* ... */ }
```

## Webhooks

When a submission isn't spam, Formbox POSTs this to the form's `webhookUrl`:

```json
{ "event": "submission.created",
  "form": { "id": "f_abc123", "name": "HYSC contact" },
  "submission": { "id": "s_…", "data": { "email": "…" }, "createdAt": "…" } }
```

The request carries these headers: `X-Formbox-Event`, `X-Formbox-Delivery` (the submission ID, so you can use it as an idempotency key), `X-Formbox-Timestamp`, and `X-Formbox-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<rawBody>")`.

If the receiver returns a 5xx, 408, or 429, or the request fails on the network, Formbox retries after 2s, 10s, and 60s. Other 4xx responses stop the retries. The outcome is saved on the submission as `webhookStatus` and `webhookAttempts`.

Verify the signature in an Express app:

```js
app.post("/hooks/formbox", express.text({ type: "*/*" }), async (req, res) => {
  if (!(await verifyWebhook(req.body, req.headers, process.env.FORMBOX_WEBHOOK_SECRET))) return res.sendStatus(401);
  const { submission } = JSON.parse(req.body);
  // ...
  res.sendStatus(200);
});
```

## Limits and trade-offs

- Rate limiting and webhook retries run in memory, so they reset on restart and assume a single instance. For multiple instances, move both to Redis or a job queue.
- Submissions can't include file uploads.
- The origin allow-list stops other websites from posting through a visitor's browser. It isn't authentication, because a script can fake any `Origin` header. The honeypot and rate limit are what hold back casual bots. Put Cloudflare Turnstile or hCaptcha in front if spam gets heavy.
