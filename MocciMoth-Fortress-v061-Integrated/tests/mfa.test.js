"use strict";
/* MFA TOTP para administradores: activación, login, anti-replay, recuperación, bloqueo, cifrado y auditoría. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const totp = require("../lib/totp");
const { createMfaSecrets } = require("../lib/mfa-secret");
const { ROOT, startServer, client, tmpDb, seedAdminAndUser, completeMfa, MFA, ADMIN, USER } = require("./helpers");

const fresh = async (env) => { const s = await startServer({ env }); await seedAdminAndUser(s); return s; };
const NUEVO = { nombre: "Peluche MFA", descripcion: "Producto de prueba", precio: 1000, stock: 5, categoria: "Peluches" };
const runReset = (dbFile, input, args = []) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [path.join(ROOT, "scripts", "reset-admin-password.js"), ...args], { env: { ...process.env, MOCCI_DB: dbFile } });
  let log = ""; ch.stdout.on("data", (d) => (log += d)); ch.stderr.on("data", (d) => (log += d));
  ch.on("exit", (code) => resolve({ code, log })); ch.stdin.end(input);
});

/* ------------------------------------ Unidades ------------------------------------ */
test("TOTP: vectores oficiales RFC 6238, ventana ±1, formato inválido y anti-reutilización", () => {
  const secret = totp.base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totp.codeAt(secret, 59_000), "287082");
  assert.equal(totp.codeAt(secret, 1_111_111_109_000), "081804");
  assert.equal(totp.codeAt(secret, 1_234_567_890_000), "005924");
  const s = totp.newSecret(), now = 1_700_000_000_000, step = totp.stepAt(now);
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(totp.verify(s, totp.codeAt(s, now), { now }), step);
  assert.equal(totp.verify(s, totp.codeAt(s, now - 30_000), { now }), step - 1);
  assert.equal(totp.verify(s, totp.codeAt(s, now + 30_000), { now }), step + 1);
  assert.equal(totp.verify(s, totp.codeAt(s, now - 90_000), { now }), null, "fuera de ventana");
  assert.equal(totp.verify(s, totp.codeAt(s, now), { now, lastStep: step }), null, "paso ya usado");
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined]) assert.equal(totp.verify(s, bad, { now }), null);
});

test("secreto en reposo: AES-256-GCM ligado al usuario, nunca en claro, con clave de archivo 600 o MOCCI_DATA_KEY", () => {
  const saved = process.env.MOCCI_DATA_KEY;
  delete process.env.MOCCI_DATA_KEY;
  try {
    const db = tmpDb().file;
    const v = createMfaSecrets(db);
    const blob = v.protect("JBSWY3DPEHPK3PXP", 7);
    assert.ok(blob.startsWith("m1.file.") && !blob.includes("JBSWY3DPEHPK3PXP"));
    assert.equal(v.reveal(blob, 7), "JBSWY3DPEHPK3PXP");
    assert.throws(() => v.reveal(blob, 8), "el secreto de un usuario no sirve para otro");
    const partes = blob.split("."); // alterar un byte real del texto cifrado: GCM debe detectarlo
    const ct = Buffer.from(partes[4], "base64"); ct[0] ^= 0xff; partes[4] = ct.toString("base64");
    assert.throws(() => v.reveal(partes.join("."), 7), "manipulado");
    if (process.platform !== "win32") assert.equal(fs.statSync(db + ".mfa.key").mode & 0o777, 0o600);
    process.env.MOCCI_DATA_KEY = "ab".repeat(32);
    const e = v.protect("JBSWY3DPEHPK3PXP", 7);
    assert.ok(e.startsWith("m1.env."));
    assert.equal(v.reveal(e, 7), "JBSWY3DPEHPK3PXP");
    delete process.env.MOCCI_DATA_KEY;
    assert.throws(() => v.reveal(e, 7), /MOCCI_DATA_KEY/, "sin la clave no se puede leer, y lo dice");
  } finally { if (saved === undefined) delete process.env.MOCCI_DATA_KEY; else process.env.MOCCI_DATA_KEY = saved; }
});

/* ------------------------------------ Activación ------------------------------------ */
test("activación: el admin no tiene privilegios hasta activar MFA; el secreto y los códigos quedan protegidos en SQLite", async () => {
  const s = await startServer();
  try {
    const a = client(s.base);
    await a.req("POST", "/api/setup-admin", ADMIN, { csrf: false });
    assert.equal((await a.login(ADMIN.email, ADMIN.password)).data.pending, "enroll");
    for (const [m, u, b] of [["GET", "/api/admin/orders"], ["GET", "/api/admin/audit"], ["POST", "/api/products", NUEVO], ["POST", "/api/admin/password", {}], ["GET", "/api/orders"]]) {
      const r = await a.req(m, u, b);
      assert.equal(r.status, 401, `${m} ${u}`);
      assert.equal(r.data.code, "mfa_required");
    }
    const me = (await a.req("GET", "/api/me")).data;
    assert.equal(me.user, null);
    assert.equal(me.pending, "enroll");

    const st = await a.req("POST", "/api/admin/mfa/setup", {});
    assert.match(st.data.secret, /^[A-Z2-7]{32}$/);
    assert.match(st.data.otpauth, /^otpauth:\/\/totp\/MocciMoth:/);
    assert.equal((await a.req("POST", "/api/admin/mfa/enable", { code: "abcdef" })).status, 400);
    assert.equal((await a.req("POST", "/api/admin/mfa/enable", { code: "000000" })).status, 400);
    const en = await a.req("POST", "/api/admin/mfa/enable", { code: totp.codeAt(st.data.secret) });
    assert.equal(en.status, 200);
    assert.equal(en.data.recoveryCodes.length, 8);
    assert.equal(new Set(en.data.recoveryCodes).size, 8);
    assert.match(en.data.recoveryCodes[0], /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    assert.equal((await a.req("GET", "/api/admin/orders")).status, 200, "tras activar, la sesión queda elevada");
    assert.equal((await a.req("POST", "/api/admin/mfa/setup", {})).status, 409, "no se puede regenerar con MFA activo");

    const d = new DatabaseSync(s.dbFile);
    const row = d.prepare("SELECT totp_secret_enc,recovery_hashes,totp_enabled FROM users WHERE role='admin'").get();
    d.close();
    assert.equal(row.totp_enabled, 1);
    assert.ok(row.totp_secret_enc.startsWith("m1.") && !row.totp_secret_enc.includes(st.data.secret), "secreto cifrado");
    for (const c of en.data.recoveryCodes) assert.ok(!row.recovery_hashes.includes(c.replace("-", "")), "códigos con hash");
    assert.ok(fs.existsSync(s.dbFile + ".mfa.key") || process.env.MOCCI_DATA_KEY, "existe la clave que lo protege");
  } finally { await s.stop(); }
});

test("activación: otras sesiones previas del admin quedan invalidadas al activar MFA", async () => {
  const s = await startServer();
  try {
    await client(s.base).req("POST", "/api/setup-admin", ADMIN, { csrf: false });
    const a = client(s.base), b = client(s.base);
    await a.login(ADMIN.email, ADMIN.password); await b.login(ADMIN.email, ADMIN.password);
    const st = await a.req("POST", "/api/admin/mfa/setup", {});
    assert.equal((await a.req("POST", "/api/admin/mfa/enable", { code: totp.codeAt(st.data.secret) })).status, 200);
    assert.equal((await b.req("GET", "/api/me")).data.pending, null, "la sesión b murió");
    assert.equal((await b.req("POST", "/api/admin/mfa/setup", {})).status, 401);
  } finally { await s.stop(); }
});

/* --------------------------------------- Login --------------------------------------- */
test("login: contraseña sola no basta; código correcto entra; incorrecto, repetido o fuera de formato no", async () => {
  const s = await fresh();
  try {
    const { secret } = MFA.get(s.dbFile);
    const c1 = client(s.base);
    const l = await c1.login(ADMIN.email, ADMIN.password);
    assert.equal(l.status, 200); assert.equal(l.data.pending, "mfa");
    assert.equal((await c1.req("GET", "/api/admin/orders")).status, 401, "con solo la contraseña no entra");
    assert.equal((await c1.req("POST", "/api/products", NUEVO)).status, 401);
    for (const mal of ["000000", "12ab", "", "1234567"]) assert.equal((await c1.req("POST", "/api/login/mfa", { code: mal })).status, 401, mal);
    const code = totp.codeAt(secret, Date.now() + 30_000); // paso siguiente (> al consumido al activar)
    const sidAntes = c1.cookie;
    assert.equal((await c1.req("POST", "/api/login/mfa", { code })).status, 200);
    assert.notEqual(c1.cookie, sidAntes, "al subir de nivel cambia el identificador de sesión");
    assert.equal((await c1.req("GET", "/api/admin/orders")).status, 200);
    assert.equal((await c1.req("GET", "/api/me")).data.user.role, "admin");

    const c2 = client(s.base); // el mismo código no sirve dos veces (anti-replay)
    await c2.login(ADMIN.email, ADMIN.password);
    assert.equal((await c2.req("POST", "/api/login/mfa", { code })).status, 401);
  } finally { await s.stop(); }
});

test("login: un cliente normal no pasa por MFA y no puede usar los endpoints de segundo factor", async () => {
  const s = await fresh();
  try {
    const u = client(s.base);
    const r = await u.login(USER.email, USER.password);
    assert.equal(r.status, 200); assert.equal(r.data.pending, null);
    assert.ok((await u.req("GET", "/api/me")).data.user);
    assert.equal((await u.req("POST", "/api/login/mfa", { code: "123456" })).status, 401);
    assert.equal((await u.req("POST", "/api/admin/mfa/setup", {})).status, 403);
    assert.equal((await u.req("POST", "/api/admin/mfa/enable", { code: "123456" })).status, 403);
    assert.equal((await client(s.base).req("POST", "/api/admin/mfa/setup", {}, { csrf: false })).status, 401, "anónimo");
  } finally { await s.stop(); }
});

test("login: los endpoints de MFA exigen token CSRF", async () => {
  const s = await fresh();
  try {
    const c = client(s.base);
    await c.login(ADMIN.email, ADMIN.password);
    const r = await c.req("POST", "/api/login/mfa", { code: totp.codeAt(MFA.get(s.dbFile).secret, Date.now() + 30_000) }, { csrf: false });
    assert.equal(r.status, 403); assert.equal(r.data.code, "csrf");
    assert.equal((await c.req("GET", "/api/admin/orders")).status, 401, "y la sesión sigue sin privilegios");
    const ev = await client(s.base).req("POST", "/api/login/mfa", { code: "123456" }, { csrf: false, headers: { Origin: "http://evil.example" } });
    assert.equal(ev.status, 403);
  } finally { await s.stop(); }
});

/* ------------------------------ Códigos de recuperación ------------------------------ */
test("recuperación: cada código funciona una sola vez, ignora mayúsculas/guiones y avisa cuántos quedan", async () => {
  const s = await fresh();
  try {
    const [r1, r2] = MFA.get(s.dbFile).recovery;
    const c = client(s.base);
    await c.login(ADMIN.email, ADMIN.password);
    const ok = await c.req("POST", "/api/login/mfa", { code: r1.toLowerCase().replace("-", " ") });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.recoveryLeft, 7);
    assert.equal((await c.req("GET", "/api/admin/orders")).status, 200);
    const c2 = client(s.base);
    await c2.login(ADMIN.email, ADMIN.password);
    assert.equal((await c2.req("POST", "/api/login/mfa", { code: r1 })).status, 401, "ya usado");
    assert.equal((await c2.req("POST", "/api/login/mfa", { code: "AAAAA-BBBBB" })).status, 401, "inventado");
    assert.equal((await c2.req("POST", "/api/login/mfa", { code: r2 })).data.recoveryLeft, 6);
  } finally { await s.stop(); }
});

test("bloqueo: 5 códigos erróneos bloquean el segundo factor incluso con el código correcto", async () => {
  const s = await fresh();
  try {
    const c = client(s.base);
    await c.login(ADMIN.email, ADMIN.password);
    for (let i = 0; i < 5; i++) assert.equal((await c.req("POST", "/api/login/mfa", { code: "000000" })).status, 401);
    const bloqueado = await c.req("POST", "/api/login/mfa", { code: totp.codeAt(MFA.get(s.dbFile).secret, Date.now() + 30_000) });
    assert.equal(bloqueado.status, 429);
    assert.equal((await c.req("GET", "/api/admin/orders")).status, 401);
  } finally { await s.stop(); }
});

/* ------------------------------------ Sesiones ------------------------------------ */
test("sesiones: cambiar la contraseña mantiene al admin verificado y cierra sus otras sesiones", async () => {
  const s = await fresh();
  try {
    const mk = async () => { const c = client(s.base); await c.login(ADMIN.email, ADMIN.password); await completeMfa(c, s); return c; };
    const A = await mk(), B = await mk();
    const r = await A.req("POST", "/api/admin/password", { actual: ADMIN.password, nueva: "OtraClaveNueva2026", confirmar: "OtraClaveNueva2026" });
    assert.equal(r.status, 200);
    assert.equal((await A.req("GET", "/api/admin/orders")).status, 200, "A sigue con privilegios");
    assert.equal((await B.req("GET", "/api/admin/orders")).status, 401, "B fue cerrada");
    const nueva = client(s.base);
    assert.equal((await nueva.login(ADMIN.email, "OtraClaveNueva2026")).data.pending, "mfa", "el MFA se conserva");
  } finally { await s.stop(); }
});

test("sesiones: una sesión pendiente de MFA puede cancelarse (logout con CSRF) y queda destruida", async () => {
  const s = await fresh();
  try {
    const c = client(s.base);
    await c.login(ADMIN.email, ADMIN.password);
    const sid = c.cookie;
    assert.equal((await c.req("POST", "/api/logout", {}, { csrf: false })).status, 403);
    assert.equal((await c.req("POST", "/api/logout", {})).status, 200);
    const ladron = client(s.base); ladron.cookie = sid;
    assert.equal((await ladron.req("GET", "/api/me")).data.pending, null);
  } finally { await s.stop(); }
});

/* ------------------------------- Clave de cifrado y fallos ------------------------------- */
test("cifrado: con MOCCI_DATA_KEY el secreto usa esa clave; sin ella el login falla con un mensaje claro y el servidor sigue vivo", async () => {
  const key = "cd".repeat(32);
  const s = await startServer({ env: { MOCCI_DATA_KEY: key } });
  try {
    await seedAdminAndUser(s);
    const d = new DatabaseSync(s.dbFile);
    assert.ok(d.prepare("SELECT totp_secret_enc FROM users WHERE role='admin'").get().totp_secret_enc.startsWith("m1.env."));
    d.close();
    const ok = client(s.base);
    await ok.login(ADMIN.email, ADMIN.password);
    assert.equal((await completeMfa(ok, s)).status, 200);
  } finally { await s.stop(); }
  const sin = await startServer({ dbFile: s.dbFile, env: { MOCCI_DATA_KEY: "" } });
  try {
    const c = client(sin.base);
    await c.login(ADMIN.email, ADMIN.password);
    const r = await c.req("POST", "/api/login/mfa", { code: "123456" });
    assert.equal(r.status, 500);
    assert.match(r.data.error, /MOCCI_DATA_KEY|reset-mfa/);
    assert.equal((await client(sin.base).req("GET", "/api/products")).status, 200, "el servidor sigue respondiendo");
  } finally { await sin.stop(); }
});

/* --------------------------------- Recuperación local --------------------------------- */
test("recuperación local: reset-admin conserva MFA; con --reset-mfa lo reinicia; ambas invalidan sesiones y conservan datos", async () => {
  const s = await fresh();
  const mk = async (srv, pw) => { const c = client(srv.base); const r = await c.login(ADMIN.email, pw); return { c, r }; };
  const a = client(s.base); await a.login(ADMIN.email, ADMIN.password); await completeMfa(a, s);
  assert.equal((await a.req("GET", "/api/admin/orders")).status, 200);
  const cuenta = () => { const d = new DatabaseSync(s.dbFile); const n = d.prepare("SELECT COUNT(*) n FROM users").get().n; d.close(); return n; };
  const antes = cuenta();

  let out = await runReset(s.dbFile, "Recuperada2026ab\nRecuperada2026ab\n");
  assert.equal(out.code, 0, out.log);
  assert.equal((await a.req("GET", "/api/admin/orders")).status, 401, "la sesión abierta murió sin reiniciar el servidor");
  assert.equal((await mk(s, "Recuperada2026ab")).r.data.pending, "mfa", "el MFA se conserva");

  out = await runReset(s.dbFile, "SegundaClave2026cd\nSegundaClave2026cd\n", ["--reset-mfa"]);
  assert.equal(out.code, 0, out.log);
  assert.match(out.log, /dos pasos/);
  const { c, r } = await mk(s, "SegundaClave2026cd");
  assert.equal(r.data.pending, "enroll", "tras --reset-mfa debe activarlo de nuevo");
  assert.equal((await c.req("GET", "/api/admin/orders")).status, 401);
  const st = await c.req("POST", "/api/admin/mfa/setup", {});
  assert.equal((await c.req("POST", "/api/admin/mfa/enable", { code: totp.codeAt(st.data.secret) })).status, 200);
  assert.equal((await c.req("GET", "/api/admin/orders")).status, 200);
  assert.equal(cuenta(), antes, "no se perdió ningún usuario");
  await s.stop();
});

/* ------------------------------------ Auditoría ------------------------------------ */
test("auditoría: activación, ingreso, fallos y uso de recuperación quedan registrados sin secretos", async () => {
  const s = await fresh();
  try {
    const { secret, recovery } = MFA.get(s.dbFile);
    const c0 = client(s.base);
    await c0.login(ADMIN.email, ADMIN.password);
    await c0.req("POST", "/api/login/mfa", { code: "000000" });
    const c1 = client(s.base);
    await c1.login(ADMIN.email, ADMIN.password);
    await c1.req("POST", "/api/login/mfa", { code: recovery[0] });
    const a = client(s.base);
    await a.login(ADMIN.email, ADMIN.password); await completeMfa(a, s);
    const logs = (await a.req("GET", "/api/admin/audit")).data;
    const acciones = logs.map((x) => x.action);
    for (const x of ["mfa_enabled", "mfa_failed", "mfa_recovery_used", "mfa_login_ok"]) assert.ok(acciones.includes(x), "falta " + x);
    const texto = JSON.stringify(logs);
    for (const sec of [secret, ...recovery, ...recovery.map((c) => c.replace("-", "")), "000000"]) assert.ok(!texto.includes(sec), "la auditoría contiene un secreto");
  } finally { await s.stop(); }
});
