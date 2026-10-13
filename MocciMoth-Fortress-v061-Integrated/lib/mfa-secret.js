"use strict";
/* Protección del secreto TOTP en reposo (AES-256-GCM, autenticado con el id de usuario).
   Clave:
     1) Si existe MOCCI_DATA_KEY (64 hex, la misma del cifrado de campos) se deriva una subclave exclusiva para MFA con HKDF.
     2) Si no, se crea <base>.mfa.key (permisos 600) junto a la base.
   A diferencia de seal(), JAMÁS cae a texto claro: un secreto TOTP en claro permitiría generar códigos de admin. */
const fs = require("node:fs");
const crypto = require("node:crypto");

function createMfaSecrets(dbFile) {
  const keyFile = process.env.MOCCI_MFA_KEY_FILE || dbFile + ".mfa.key";
  function envKey() {
    const raw = process.env.MOCCI_DATA_KEY || "";
    if (!raw) return null;
    if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("MOCCI_DATA_KEY debe contener exactamente 64 caracteres hexadecimales.");
    return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "hex"), Buffer.alloc(0), "moccimoth-mfa-v1", 32));
  }
  function fileKey(create) {
    if (!fs.existsSync(keyFile)) {
      if (!create) return null;
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    }
    const k = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
    if (k.length !== 32) throw new Error(`Clave MFA inválida en ${keyFile}`);
    return k;
  }
  return {
    protect(secret, userId) {
      let src = "env", key = envKey();
      if (!key) { src = "file"; key = fileKey(true); }
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(`mfa:${userId}`));
      const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
      return ["m1", src, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
    },
    reveal(blob, userId) {
      const [v, src, iv, tag, ct] = String(blob).split(".");
      if (v !== "m1" || !ct) throw new Error("formato inválido");
      const key = src === "env" ? envKey() : fileKey(false);
      if (!key) throw new Error(src === "env" ? "falta MOCCI_DATA_KEY" : "falta el archivo .mfa.key");
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAAD(Buffer.from(`mfa:${userId}`));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
    },
  };
}
module.exports = { createMfaSecrets };
