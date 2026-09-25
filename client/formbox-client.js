// Formbox client — drop this file into any app (browser or Node 18+). No dependencies.
//
//   import { submitForm, FormboxClient, verifyWebhook } from "./formbox-client.js";
//
//   // 1) Submit from a browser or server
//   await submitForm("https://forms.example.com", "f_abc123", { email, message });
//
//   // 2) Read submissions from a server (use the form's fk_ key, or the admin key)
//   const fb = new FormboxClient("https://forms.example.com", process.env.FORMBOX_KEY);
//   const { items, nextCursor } = await fb.listSubmissions("f_abc123", { limit: 20 });
//
//   // 3) Verify a webhook in your backend (Node only)
//   const ok = await verifyWebhook(rawBody, req.headers, process.env.FORMBOX_WEBHOOK_SECRET);

/**
 * Submit data to a form. Resolves to { ok: true, id } or throws FormboxError.
 * @param {string} baseUrl
 * @param {string} formId
 * @param {Record<string, unknown> | FormData | HTMLFormElement} data
 */
export async function submitForm(baseUrl, formId, data) {
  let body = data;
  if (typeof HTMLFormElement !== "undefined" && data instanceof HTMLFormElement) body = new FormData(data);
  if (typeof FormData !== "undefined" && body instanceof FormData) body = Object.fromEntries(body.entries());
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/f/${encodeURIComponent(formId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new FormboxError(res.status, json.error?.code ?? "unknown", json.error?.message ?? res.statusText);
  return json;
}

export class FormboxError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "FormboxError";
    this.status = status;
    this.code = code;
  }
}

/** Management/read API client. Keep the key server-side. */
export class FormboxClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async request(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    const payload = isJson ? await res.json() : await res.text();
    if (!res.ok) throw new FormboxError(res.status, payload?.error?.code ?? "unknown", payload?.error?.message ?? res.statusText);
    return payload;
  }

  me() { return this.request("GET", "/api/me"); }
  listForms() { return this.request("GET", "/api/forms"); }
  getForm(id) { return this.request("GET", `/api/forms/${id}`); }
  createForm(input) { return this.request("POST", "/api/forms", input); }
  updateForm(id, input) { return this.request("PATCH", `/api/forms/${id}`, input); }
  deleteForm(id) { return this.request("DELETE", `/api/forms/${id}`); }

  /** @param {{limit?: number, before?: string, after?: string, spam?: "exclude"|"only"|"include"}} [opts] */
  listSubmissions(formId, opts = {}) {
    const q = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    return this.request("GET", `/api/forms/${formId}/submissions${q.size ? `?${q}` : ""}`);
  }

  /** Iterate every submission, newest first. */
  async *allSubmissions(formId, opts = {}) {
    let before;
    do {
      const page = await this.listSubmissions(formId, { ...opts, limit: 500, before });
      yield* page.items;
      before = page.nextCursor ?? undefined;
    } while (before);
  }

  exportCsv(formId) { return this.request("GET", `/api/forms/${formId}/submissions.csv`); }
  getSubmission(id) { return this.request("GET", `/api/submissions/${id}`); }
  markSpam(id, spam = true) { return this.request("PATCH", `/api/submissions/${id}`, { spam }); }
  deleteSubmission(id) { return this.request("DELETE", `/api/submissions/${id}`); }
}

/**
 * Verify a Formbox webhook. `rawBody` must be the exact bytes/string received.
 * @param {string} rawBody
 * @param {Record<string, string | string[] | undefined> | Headers} headers
 * @param {string} secret  whsec_... from the form
 * @param {number} [toleranceSec=300]
 */
export async function verifyWebhook(rawBody, headers, secret, toleranceSec = 300) {
  const get = (k) => (typeof headers.get === "function" ? headers.get(k) : headers[k]);
  const ts = Number(get("x-formbox-timestamp"));
  const sig = String(get("x-formbox-signature") ?? "");
  if (!ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
