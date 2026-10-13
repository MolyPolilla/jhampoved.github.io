"use strict";
/* TOTP (RFC 6238): HMAC-SHA1, 6 dígitos, paso de 30 s. Sin dependencias. */
const crypto = require("node:crypto");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = ((value << 8) | b) & 0xfffff;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).replace(/[\s=-]/g, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("base32 inválido");
    value = ((value << 5) | i) & 0xfffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newSecret = () => base32Encode(crypto.randomBytes(20)); // 160 bits

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
const stepAt = (ms) => Math.floor(ms / 1000 / 30);
const codeAt = (secretB32, ms = Date.now()) => hotp(base32Decode(secretB32), stepAt(ms));

/* Devuelve el paso que coincidió o null. Tolera ±1 paso de reloj y rechaza reutilizar un paso ya consumido (`lastStep`). */
function verify(secretB32, token, { now = Date.now(), window = 1, lastStep = 0 } = {}) {
  const t = String(token || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(t)) return null;
  const key = base32Decode(secretB32);
  const cur = stepAt(now);
  let found = null;
  for (let s = cur - window; s <= cur + window; s++) { // recorre todo: tiempo constante
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(t)) && s > lastStep && found === null) found = s;
  }
  return found;
}
const otpauthUri = (secret, email, issuer = "MocciMoth") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { base32Encode, base32Decode, newSecret, hotp, codeAt, verify, stepAt, otpauthUri };
