"use strict";
/* Utilidades de prueba: levanta server.js de verdad con una base TEMPORAL
   (nunca toca tu moccimoth.db) y un cliente HTTP mínimo con cookies y CSRF. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { DatabaseSync } = require("node:sqlite");
const totp = require("../lib/totp");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mocci-test-"));
  return { dir, file: path.join(dir, "test.db") };
}

async function startServer({ dbFile, env = {} } = {}) {
  const db = dbFile ? { file: dbFile } : tmpDb();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MOCCI_DB: db.file, MOCCI_COOKIE_SECURE: "", MOCCI_TRUST_PROXY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("El servidor no arrancó a tiempo")), 10_000);
    child.stdout.on("data", (d) => { if (String(d).includes("MocciMoth")) { clearTimeout(t); resolve(); } });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (c) => { clearTimeout(t); reject(new Error("El servidor terminó con código " + c)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, dbFile: db.file,
    stop: () => new Promise((r) => { child.removeAllListeners("exit"); child.once("exit", r); child.kill(); }),
  };
}

/* Cliente con "navegador" simulado: guarda la cookie sid y el token CSRF. */
function client(base) {
  const c = { cookie: "", csrf: null, lastSetCookie: "" };
  c.req = async (method, url, body, { csrf = true, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (c.cookie) h.Cookie = c.cookie;
    if (csrf && c.csrf) h["X-CSRF-Token"] = c.csrf;
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) { c.lastSetCookie = sc; const pair = sc.split(";")[0]; c.cookie = pair === "sid=" ? "" : pair; }
    let data = {};
    try { data = await r.json(); } catch { /* sin cuerpo */ }
    if (typeof data.csrfToken === "string") c.csrf = data.csrfToken;
    return { status: r.status, data, headers: r.headers };
  };
  c.login = async (email, password) => c.req("POST", "/api/login", { email, password });
  return c;
}

const ADMIN = { nombre: "Admin Test", email: "admin@moccimoth.test", password: "ClaveSegura123" };
const USER = { nombre: "Cliente Test", email: "cliente@moccimoth.test", password: "ClienteClave99" };

/* Secretos TOTP por base de datos (para que los tests completen el segundo factor del admin). */
const MFA = new Map(); // dbFile -> { secret, recovery }
function freeStep(dbFile) { // el servidor impide reutilizar un paso TOTP; los tests inician sesión de admin varias veces
  const d = new DatabaseSync(dbFile);
  d.exec("UPDATE users SET totp_last_step=0 WHERE role='admin'");
  d.close();
}
async function completeMfa(c, srv) {
  const m = MFA.get(srv.dbFile);
  freeStep(srv.dbFile);
  const r = await c.req("POST", "/api/login/mfa", { code: totp.codeAt(m.secret) });
  if (r.status !== 200) throw new Error("MFA de prueba falló: " + JSON.stringify(r.data));
  return r;
}
/* Crea admin (con MFA activado) y un cliente. Recibe el objeto devuelto por startServer. */
async function seedAdminAndUser(srv, setupToken = "") {
  if (typeof srv === "string") throw new Error("seedAdminAndUser ahora recibe el objeto de startServer(), no srv.base");
  const a = client(srv.base);
  const r1 = await a.req("POST", "/api/setup-admin", { ...ADMIN, setupToken }, { csrf: false });
  if (r1.status !== 201) throw new Error("setup-admin falló: " + JSON.stringify(r1.data));
  const lg = await a.login(ADMIN.email, ADMIN.password);
  if (lg.data.pending !== "enroll") throw new Error("se esperaba pending=enroll: " + JSON.stringify(lg.data));
  const st = await a.req("POST", "/api/admin/mfa/setup", {});
  const en = await a.req("POST", "/api/admin/mfa/enable", { code: totp.codeAt(st.data.secret) });
  if (en.status !== 200) throw new Error("mfa/enable falló: " + JSON.stringify(en.data));
  MFA.set(srv.dbFile, { secret: st.data.secret, recovery: en.data.recoveryCodes });
  const r2 = await a.req("POST", "/api/register", USER, { csrf: false });
  if (r2.status !== 201) throw new Error("register falló: " + JSON.stringify(r2.data));
}

const ENVIO = { nombre: "Cliente Test", telefono: "3804123456", direccion: "Calle Falsa 123", ciudad: "La Rioja", provincia: "La Rioja", cp: "5300" };
const PAGO_OK = { metodo: "tarjeta", tarjeta: { numero: "4242 4242 4242 4242", titular: "Cliente Test", vencimiento: "12/35", cvv: "123" } };

module.exports = { ROOT, startServer, client, tmpDb, seedAdminAndUser, completeMfa, freeStep, MFA, ADMIN, USER, ENVIO, PAGO_OK };
