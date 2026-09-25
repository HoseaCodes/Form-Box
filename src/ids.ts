import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomString(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 36];
  return out;
}

/** Public form id, e.g. "f_k3j9x2m1qa". Safe to embed in HTML. */
export const formId = () => `f_${randomString(10)}`;

/**
 * Time-sortable submission id: 9 chars of base36 millis + 8 random chars.
 * Lexicographic order == creation order, so the id doubles as a pagination cursor.
 */
let lastMs = 0;
let seq = 0;
export function submissionId(now = Date.now()): string {
  if (now === lastMs) seq++;
  else {
    lastMs = now;
    seq = 0;
  }
  const time = now.toString(36).padStart(9, "0");
  const counter = seq.toString(36).padStart(2, "0");
  return `s_${time}${counter}${randomString(6)}`;
}

/** Secret key; shown once on creation. */
export const secretKey = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
