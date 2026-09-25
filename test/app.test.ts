import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { DefaultNotifier, signPayload, type Notifier } from "../src/notify.js";
// @ts-expect-error plain JS client
import { verifyWebhook } from "../client/formbox-client.js";

const ADMIN = "test-admin-key-0123456789abcdef";
const admin = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

let store: Store;
let notified: string[];
let app: ReturnType<typeof createApp>;

function setup(overrides: Record<string, string> = {}) {
  const config = loadConfig({ ADMIN_API_KEY: ADMIN, PUBLIC_URL: "https://forms.test", RATE_LIMIT_PER_MINUTE: "5", ...overrides });
  store = new Store(":memory:");
  notified = [];
  const notifier: Notifier = { onSubmission: (_f, s) => notified.push(s.id), redeliverWebhook: () => {} };
  app = createApp({ store, config, notifier });
}
beforeEach(() => setup());

async function createForm(body: Record<string, unknown> = { name: "Contact" }) {
  const res = await app.request("/api/forms", { method: "POST", headers: admin, body: JSON.stringify(body) });
  assert.equal(res.status, 201);
  return res.json() as Promise<any>;
}

test("JSON submission is stored and returned via API", async () => {
  const form = await createForm();
  assert.match(form.id, /^f_/);
  assert.match(form.apiKey, /^fk_/);
  assert.equal(form.endpoint, `https://forms.test/f/${form.id}`);

  const res = await app.request(`/f/${form.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", message: "hi", _subject: "Hello" }),
  });
  assert.equal(res.status, 201);
  const { id } = (await res.json()) as any;
  assert.deepEqual(notified, [id]);

  const list = (await (await app.request(`/api/forms/${form.id}/submissions`, { headers: admin })).json()) as any;
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.items[0].data, { email: "a@b.co", message: "hi" }); // _subject stripped
});

test("HTML form post redirects; _next only honoured on allowed origin", async () => {
  const form = await createForm({ name: "Site", allowedOrigins: ["https://site.test"] });
  const post = (next: string) =>
    app.request(`/f/${form.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://site.test" },
      body: new URLSearchParams({ name: "Dom", _next: next }).toString(),
    });
  let res = await post("https://site.test/thanks");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://site.test/thanks");

  res = await post("https://evil.test/phish");
  assert.equal(res.headers.get("location"), "https://forms.test/thanks");
});

test("origin allow-list blocks other sites and sets CORS", async () => {
  const form = await createForm({ name: "Site", allowedOrigins: ["https://site.test"] });
  const bad = await app.request(`/f/${form.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.test" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(bad.status, 403);

  const pre = await app.request(`/f/${form.id}`, {
    method: "OPTIONS",
    headers: { origin: "https://site.test", "access-control-request-method": "POST" },
  });
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://site.test");
});

test("honeypot marks spam silently, and spam is hidden by default", async () => {
  const form = await createForm();
  const res = await app.request(`/f/${form.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "bot@x.co", _gotcha: "i am a bot" }),
  });
  assert.equal(res.status, 201);
  const list = (await (await app.request(`/api/forms/${form.id}/submissions`, { headers: admin })).json()) as any;
  assert.equal(list.items.length, 0);
  const spam = (await (await app.request(`/api/forms/${form.id}/submissions?spam=only`, { headers: admin })).json()) as any;
  assert.equal(spam.items.length, 1);
});

test("required fields, empty body, disabled form", async () => {
  const form = await createForm({ name: "R", requiredFields: ["email"] });
  const post = (b: unknown) =>
    app.request(`/f/${form.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post({ message: "x" })).status, 422);
  assert.equal((await post({})).status, 422);
  await app.request(`/api/forms/${form.id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ enabled: false }) });
  assert.equal((await post({ email: "a@b.co" })).status, 403);
});

test("rate limit per IP per form", async () => {
  const form = await createForm();
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await app.request(`/f/${form.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ i }),
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
});

test("form key can only read its own form", async () => {
  const a = await createForm({ name: "A" });
  const b = await createForm({ name: "B" });
  const key = { authorization: `Bearer ${a.apiKey}` };
  assert.equal((await app.request(`/api/forms/${a.id}/submissions`, { headers: key })).status, 200);
  assert.equal((await app.request(`/api/forms/${b.id}/submissions`, { headers: key })).status, 404);
  assert.equal((await app.request(`/api/forms`, { headers: key })).status, 403);
  const me = (await (await app.request(`/api/forms/${a.id}`, { headers: key })).json()) as any;
  assert.equal(me.apiKey, undefined); // secrets not exposed to form keys
  assert.equal((await app.request(`/api/forms`, { headers: { authorization: "Bearer nope" } })).status, 401);
});

test("pagination cursor and CSV export", async () => {
  const form = await createForm();
  setup({ RATE_LIMIT_PER_MINUTE: "1000" });
  const f2 = store.createForm({ name: "P" });
  for (let i = 0; i < 5; i++) {
    await app.request(`/f/${f2.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: String(i), note: i === 0 ? "=cmd" : "a,b" }),
    });
  }
  const p1 = (await (await app.request(`/api/forms/${f2.id}/submissions?limit=2`, { headers: admin })).json()) as any;
  assert.deepEqual(p1.items.map((s: any) => s.data.n), ["4", "3"]);
  const p2 = (await (await app.request(`/api/forms/${f2.id}/submissions?limit=2&before=${p1.nextCursor}`, { headers: admin })).json()) as any;
  assert.deepEqual(p2.items.map((s: any) => s.data.n), ["2", "1"]);

  const csv = await (await app.request(`/api/forms/${f2.id}/submissions.csv`, { headers: admin })).text();
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "id,created_at,n,note");
  assert.equal(lines.length, 6);
  assert.ok(lines.at(-1)!.endsWith(",0,'=cmd"));
  assert.ok(lines[1].endsWith(',4,"a,b"'));
  void form;
});

test("webhook is signed, retried on 5xx, and verifiable with the client helper", async () => {
  let calls = 0;
  let received: { body: string; headers: Record<string, string> } | null = null;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      if (calls === 1) { res.writeHead(503).end(); return; }
      received = { body, headers: req.headers as Record<string, string> };
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const config = loadConfig({ ADMIN_API_KEY: ADMIN });
  const s = new Store(":memory:");
  const form = s.createForm({ name: "Hook", webhookUrl: `http://127.0.0.1:${port}/hook` });
  const sub = s.createSubmission(form.id, { hello: "world" }, {}, { spam: false, webhookPending: true });
  const notifier = new DefaultNotifier(s, config, fetch, [0, 10, 10]);
  assert.equal(await notifier.deliverWebhook(form, sub), true);
  server.close();

  assert.equal(calls, 2);
  assert.equal(s.getSubmission(sub.id)!.webhookStatus, "delivered");
  const r = received!;
  assert.equal(JSON.parse(r.body).submission.data.hello, "world");
  assert.equal(await verifyWebhook(r.body, r.headers, form.webhookSecret), true);
  assert.equal(await verifyWebhook(r.body + " ", r.headers, form.webhookSecret), false);
  assert.equal(r.headers["x-formbox-signature"], signPayload(form.webhookSecret!, Number(r.headers["x-formbox-timestamp"]), r.body));
});
