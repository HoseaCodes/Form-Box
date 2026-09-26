import { test } from "node:test";
import assert from "node:assert/strict";
import { sendAutoresponse } from "../src/autorespond.js";
import { loadConfig } from "../src/config.js";
import type { Form, Submission } from "../src/db.js";

const FORM_ID = "f_test123";

const form = { id: FORM_ID, name: "Magnet" } as Form;
const submission = (data: Record<string, unknown>) =>
  ({ id: "s_1", formId: FORM_ID, data } as Submission);

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    ADMIN_API_KEY: "test-admin-key-0123456789abcdef",
    EMAIL_API_URL: "https://email.test/email",
    EMAIL_API_KEY: "secret-key",
    AUTORESPOND: JSON.stringify({
      [FORM_ID]: { subject: "Your download", text: "Here it is: https://example.test/f.pdf" },
    }),
    ...overrides,
  });
}

/** Records the outgoing request and returns a canned response. */
function spyFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("", { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("posts the email API's expected shape, with the key in the header", async () => {
  const { calls, impl } = spyFetch();
  await sendAutoresponse(config(), form, submission({ email: "person@example.com" }), impl);

  assert.equal(calls.length, 1, "exactly one attempt");
  assert.equal(calls[0].url, "https://email.test/email");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "secret-key");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, [{ email: "person@example.com" }]);
  assert.equal(body.subject, "Your download");
  assert.match(body.textContent, /example\.test\/f\.pdf/);
});

test("does not retry when the email API fails", async () => {
  const { calls, impl } = spyFetch(500);
  await assert.rejects(
    () => sendAutoresponse(config(), form, submission({ email: "person@example.com" }), impl),
    /responded 500/,
  );
  assert.equal(calls.length, 1, "a retry here could double-send");
});

test("sends nothing for a form with no template", async () => {
  const { calls, impl } = spyFetch();
  await sendAutoresponse(config(), { ...form, id: "f_other" } as Form,
    submission({ email: "person@example.com" }), impl);
  assert.equal(calls.length, 0);
});

test("sends nothing when the address is missing or malformed", async () => {
  const { calls, impl } = spyFetch();
  await sendAutoresponse(config(), form, submission({ email: "not-an-address" }), impl);
  await sendAutoresponse(config(), form, submission({}), impl);
  assert.equal(calls.length, 0);
});

test("honours a custom recipient field", async () => {
  const { calls, impl } = spyFetch();
  const cfg = config({
    AUTORESPOND: JSON.stringify({ [FORM_ID]: { subject: "s", text: "t", field: "work_email" } }),
  });
  await sendAutoresponse(cfg, form, submission({ work_email: "a@b.com", email: "wrong@b.com" }), impl);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).to, [{ email: "a@b.com" }]);
});

test("throws a clear error when configured but the API is not", async () => {
  const { impl } = spyFetch();
  const cfg = config({ EMAIL_API_URL: "", EMAIL_API_KEY: "" });
  await assert.rejects(
    () => sendAutoresponse(cfg, form, submission({ email: "a@b.com" }), impl),
    /EMAIL_API_URL/,
  );
});

test("malformed AUTORESPOND disables autoresponses instead of crashing", () => {
  const cfg = loadConfig({ ADMIN_API_KEY: "x".repeat(24), AUTORESPOND: "{not json" });
  assert.deepEqual(cfg.autorespond, {});
});
