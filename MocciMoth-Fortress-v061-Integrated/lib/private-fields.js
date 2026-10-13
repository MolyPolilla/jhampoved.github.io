"use strict";
const crypto = require("node:crypto");
// Clave de 32 bytes en hexadecimal; nunca guardarla en el ZIP ni en SQLite.
const raw = process.env.MOCCI_DATA_KEY || "";
if (raw && !/^[a-f0-9]{64}$/i.test(raw)) throw new Error("MOCCI_DATA_KEY debe contener exactamente 64 caracteres hexadecimales.");
const key = raw ? Buffer.from(raw, "hex") : null;
const PREFIX = "enc:v1:";
function seal(value) {
  const str = String(value ?? "");
  if (!str || str.startsWith(PREFIX)) return str;
  if (!key) return str; // compatibilidad con bases existentes en modo local sin cifrado
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function unseal(value) {
  const str = String(value ?? "");
  if (!str.startsWith(PREFIX)) return str;
  if (!key) throw new Error("Hay datos cifrados: configurá MOCCI_DATA_KEY para acceder a ellos.");
  const payload = Buffer.from(str.slice(PREFIX.length), "base64");
  if (payload.length < 29) throw new Error("Dato cifrado inválido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}
module.exports = { seal, unseal };
