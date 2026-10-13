"use strict";
/* Pruebas básicas de MocciMoth v0.4: permisos, CSRF, cookies, descuentos, stock, checkout
   y recuperación local de la contraseña admin. Ejecutar con:  npm test */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, startServer, client, seedAdminAndUser, completeMfa, ADMIN, USER, ENVIO, PAGO_OK } = require("./helpers");

let srv;
test.before(async () => { srv = await startServer(); await seedAdminAndUser(srv); });
test.after(async () => { await srv.stop(); });

const loginAs = async (who) => { const c = client(srv.base); const r = await c.login(who.email, who.password); assert.equal(r.status, 200); if (r.data.pending) await completeMfa(c, srv); return c; };
const productos = async () => (await client(srv.base).req("GET", "/api/products")).data;
const NUEVO = { nombre: "Peluche Test", descripcion: "Producto de prueba", precio: 1000, stock: 5, categoria: "Peluches" };

/* ---------------------------------- Permisos ---------------------------------- */
test("permisos: anónimo no puede escribir productos ni ver pedidos admin", async () => {
  const c = client(srv.base);
  assert.equal((await c.req("POST", "/api/products", NUEVO)).status, 401);
  assert.equal((await c.req("GET", "/api/admin/orders")).status, 401);
  assert.equal((await c.req("POST", "/api/checkout", { items: [] })).status, 401);
});

test("permisos: usuario común recibe 403 en acciones de admin", async () => {
  const u = await loginAs(USER);
  assert.equal((await u.req("POST", "/api/products", NUEVO)).status, 403);
  assert.equal((await u.req("PATCH", "/api/products/1/stock", { stock: 999 })).status, 403);
  assert.equal((await u.req("DELETE", "/api/products/1")).status, 403);
  assert.equal((await u.req("GET", "/api/admin/orders")).status, 403);
  assert.equal((await u.req("POST", "/api/admin/password", { actual: "x", nueva: "y", confirmar: "y" })).status, 403);
});

test("permisos: el admin crea, edita y elimina productos", async () => {
  const a = await loginAs(ADMIN);
  const r = await a.req("POST", "/api/products", NUEVO);
  assert.equal(r.status, 201);
  const id = r.data.id;
  assert.equal((await a.req("PUT", `/api/products/${id}`, { ...NUEVO, precio: 1500 })).status, 200);
  assert.equal((await a.req("PATCH", `/api/products/${id}/stock`, { stock: 7 })).data.stock, 7);
  assert.equal((await a.req("DELETE", `/api/products/${id}`)).status, 200);
});

test("permisos: un cliente no ve pedidos ajenos (el admin sí)", async () => {
  const u = await loginAs(USER);
  const p = (await productos())[0];
  const r = await u.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 1 }], envio: ENVIO, pago: PAGO_OK });
  assert.equal(r.status, 201);
  const id = r.data.pedido.id;
  // otro cliente
  const otro = client(srv.base);
  await otro.req("POST", "/api/register", { nombre: "Otra Persona", email: "otra@moccimoth.test", password: "OtraClave1234" }, { csrf: false });
  await otro.login("otra@moccimoth.test", "OtraClave1234");
  assert.equal((await otro.req("GET", `/api/orders/${id}`)).status, 404);
  assert.equal((await u.req("GET", `/api/orders/${id}`)).status, 200);
  const a = await loginAs(ADMIN);
  assert.equal((await a.req("GET", `/api/orders/${id}`)).status, 200);
});

/* ------------------------------------ CSRF ------------------------------------ */
test("CSRF: sin token o con token incorrecto se rechaza (403, code csrf)", async () => {
  const a = await loginAs(ADMIN);
  const sinToken = await a.req("POST", "/api/products", NUEVO, { csrf: false });
  assert.equal(sinToken.status, 403);
  assert.equal(sinToken.data.code, "csrf");
  const malo = await a.req("POST", "/api/products", NUEVO, { csrf: false, headers: { "X-CSRF-Token": "0".repeat(48) } });
  assert.equal(malo.status, 403);
  assert.equal((await a.req("POST", "/api/products", NUEVO)).status, 201); // con token correcto funciona
});

test("CSRF: el token de otra sesión no sirve", async () => {
  const a = await loginAs(ADMIN);
  const b = await loginAs(ADMIN);
  assert.notEqual(a.csrf, b.csrf);
  const r = await a.req("POST", "/api/products", NUEVO, { csrf: false, headers: { "X-CSRF-Token": b.csrf } });
  assert.equal(r.status, 403);
});

test("CSRF: logout también lo exige y /api/me entrega el token", async () => {
  const u = await loginAs(USER);
  const me = await u.req("GET", "/api/me");
  assert.equal(me.data.csrfToken, u.csrf);
  assert.equal((await u.req("POST", "/api/logout", undefined, { csrf: false })).status, 403);
  assert.equal((await u.req("POST", "/api/logout")).status, 200);
  assert.equal((await u.req("GET", "/api/me")).data.user, null);
});

test("CSRF: un origen distinto sigue bloqueado aunque tenga el token", async () => {
  const a = await loginAs(ADMIN);
  const r = await a.req("POST", "/api/products", NUEVO, { headers: { Origin: "http://sitio-malicioso.example" } });
  assert.equal(r.status, 403);
});

/* ----------------------------------- Cookies ---------------------------------- */
test("cookies: en localhost por HTTP no llevan Secure, pero sí HttpOnly y SameSite", async () => {
  const c = client(srv.base);
  await c.login(USER.email, USER.password);
  assert.match(c.lastSetCookie, /HttpOnly/);
  assert.match(c.lastSetCookie, /SameSite=Lax/);
  assert.doesNotMatch(c.lastSetCookie, /Secure/);
  assert.doesNotMatch(c.lastSetCookie, /X-Forwarded/);
});

test("setup admin: detrás de proxy requiere token de instalación de un solo uso", async () => {
  const token = "a".repeat(64);
  const proxied = await startServer({ env: { MOCCI_TRUST_PROXY: "1", MOCCI_SETUP_TOKEN: token } });
  try {
    const c = client(proxied.base);
    assert.equal((await c.req("GET", "/api/setup-status")).data.setupTokenRequired, true);
    assert.equal((await c.req("POST", "/api/setup-admin", ADMIN, { csrf: false })).status, 403);
    assert.equal((await c.req("POST", "/api/setup-admin", { ...ADMIN, setupToken: "wrong" }, { csrf: false })).status, 403);
    assert.equal((await c.req("POST", "/api/setup-admin", { ...ADMIN, setupToken: token }, { csrf: false })).status, 201);
    assert.equal((await c.req("POST", "/api/setup-admin", { ...ADMIN, setupToken: token }, { csrf: false })).status, 409);
  } finally { await proxied.stop(); }
});

test("cookies: con HTTPS (proxy de confianza o MOCCI_COOKIE_SECURE=1) llevan Secure", async () => {
  const token = "b".repeat(64);
  const proxied = await startServer({ env: { MOCCI_TRUST_PROXY: "1", MOCCI_SETUP_TOKEN: token } });
  try {
    await seedAdminAndUser(proxied, token);
    const c = client(proxied.base);
    const r = await c.req("POST", "/api/login", { email: USER.email, password: USER.password }, { headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(r.status, 200);
    assert.match(c.lastSetCookie, /; Secure/);
    // sin proxy de confianza, X-Forwarded-Proto se ignora (no se puede falsear)
    const c2 = client(srv.base);
    await c2.req("POST", "/api/login", { email: USER.email, password: USER.password }, { headers: { "X-Forwarded-Proto": "https" } });
    assert.doesNotMatch(c2.lastSetCookie, /Secure/);
  } finally { await proxied.stop(); }
  const forced = await startServer({ env: { MOCCI_COOKIE_SECURE: "1" } });
  try {
    await seedAdminAndUser(forced);
    const c = client(forced.base);
    await c.login(USER.email, USER.password);
    assert.match(c.lastSetCookie, /; Secure/);
  } finally { await forced.stop(); }
});

/* ---------------------------------- Descuentos -------------------------------- */
test("descuentos: 1–2 u. 0%, 3–4 10%, 5–7 20%, 8+ 25% (recalculados por el servidor)", async () => {
  const p = (await productos()).find((x) => x.stock >= 8);
  const c = client(srv.base);
  const casos = [[1, 0], [2, 0], [3, 10], [4, 10], [5, 20], [7, 20], [8, 25]];
  for (const [unidades, pct] of casos) {
    const q = (await c.req("POST", "/api/cart/quote", { items: [{ id: p.id, cantidad: unidades }] })).data;
    assert.equal(q.unidades, unidades);
    assert.equal(q.descuento_pct, pct, `${unidades} u. debería dar ${pct}%`);
    assert.equal(q.subtotal, p.precio * unidades);
    assert.equal(q.descuento, Math.round((q.subtotal * pct) / 100));
    assert.equal(q.total, q.subtotal - q.descuento);
  }
});

test("descuentos: cuentan unidades totales entre productos y el navegador no impone precios", async () => {
  const [a, b] = await productos();
  const q = (await client(srv.base).req("POST", "/api/cart/quote", {
    items: [{ id: a.id, cantidad: 2, precio: 1, descuento_pct: 99 }, { id: b.id, cantidad: 1, precio: 1, total: 1 }],
  })).data;
  assert.equal(q.unidades, 3);
  assert.equal(q.descuento_pct, 10);
  assert.equal(q.subtotal, a.precio * 2 + b.precio);
});

/* ------------------------------------ Stock ----------------------------------- */
test("stock: el presupuesto recorta a lo disponible y avisa; agotado se quita", async () => {
  const a = await loginAs(ADMIN);
  const id = (await a.req("POST", "/api/products", { ...NUEVO, nombre: "Stock Corto", stock: 2 })).data.id;
  const c = client(srv.base);
  const q = (await c.req("POST", "/api/cart/quote", { items: [{ id, cantidad: 10 }] })).data;
  assert.equal(q.lineas[0].cantidad, 2);
  assert.equal(q.avisos[0].tipo, "stock");
  await a.req("PATCH", `/api/products/${id}/stock`, { stock: 0 });
  const q2 = (await c.req("POST", "/api/cart/quote", { items: [{ id, cantidad: 1 }] })).data;
  assert.equal(q2.lineas.length, 0);
  assert.equal(q2.avisos[0].tipo, "agotado");
});

test("stock: el checkout descuenta stock y no permite sobrevender", async () => {
  const a = await loginAs(ADMIN);
  const id = (await a.req("POST", "/api/products", { ...NUEVO, nombre: "Stock Checkout", stock: 3 })).data.id;
  const u = await loginAs(USER);
  const r = await u.req("POST", "/api/checkout", { items: [{ id, cantidad: 2 }], envio: ENVIO, pago: PAGO_OK });
  assert.equal(r.status, 201);
  assert.equal((await productos()).find((x) => x.id === id).stock, 1);
  // pedir 2 cuando queda 1: 409 y el stock no se toca ni se crea pedido
  const r2 = await u.req("POST", "/api/checkout", { items: [{ id, cantidad: 2 }], envio: ENVIO, pago: PAGO_OK });
  assert.equal(r2.status, 409);
  assert.equal((await productos()).find((x) => x.id === id).stock, 1);
});

/* ----------------------------------- Checkout --------------------------------- */
test("checkout: pedido correcto con totales, descuento y snapshot de precios", async () => {
  const [p] = await productos();
  const u = await loginAs(USER);
  const q = (await u.req("POST", "/api/cart/quote", { items: [{ id: p.id, cantidad: 3 }] })).data;
  const r = await u.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 3 }], totalEsperado: q.total, envio: ENVIO, pago: PAGO_OK });
  assert.equal(r.status, 201);
  const o = r.data.pedido;
  assert.match(o.numero_pedido, /^MM-\d{4}-\d{6}$/);
  assert.equal(o.descuento_pct, 10);
  assert.equal(o.total, q.total);
  assert.equal(o.ultimos4, "4242");
  assert.equal(o.marca, "Visa");
  assert.equal(o.items[0].precio, p.precio);
  assert.ok(!JSON.stringify(o).includes("4242424242424242"), "el número completo nunca se devuelve");
});

test("checkout: validaciones (carrito vacío, tarjeta real, total desactualizado, sin CSRF)", async () => {
  const [p] = await productos();
  const u = await loginAs(USER);
  assert.equal((await u.req("POST", "/api/checkout", { items: [], envio: ENVIO, pago: PAGO_OK })).status, 400);
  const real = { metodo: "tarjeta", tarjeta: { numero: "4532 0151 1283 0366", titular: "Cliente Test", vencimiento: "12/35", cvv: "123" } };
  const r = await u.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 1 }], envio: ENVIO, pago: real });
  assert.equal(r.status, 400);
  assert.ok(r.data.errores["pago.numero"]);
  const r2 = await u.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 1 }], totalEsperado: 1, envio: ENVIO, pago: PAGO_OK });
  assert.equal(r2.status, 409);
  const r3 = await u.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 1 }], envio: ENVIO, pago: PAGO_OK }, { csrf: false });
  assert.equal(r3.status, 403);
});

/* ---------------------------- Recuperación local admin ------------------------- */
test("recuperación local: cambia solo la clave del admin y conserva todos los datos", async () => {
  const s = await startServer();
  await seedAdminAndUser(s);
  const u = client(s.base);
  await u.login(USER.email, USER.password);
  const [p] = (await u.req("GET", "/api/products")).data;
  assert.equal((await u.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 1 }], envio: ENVIO, pago: PAGO_OK })).status, 201);
  await s.stop();

  const count = () => {
    const d = new DatabaseSync(s.dbFile);
    const out = ["users", "products", "orders", "order_items"].map((t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
    d.close();
    return out;
  };
  const before = count();

  const nueva = "NuevaClave2026x";
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(ROOT, "scripts", "reset-admin-password.js")], { env: { ...process.env, MOCCI_DB: s.dbFile } });
    let log = "";
    ch.stdout.on("data", (d) => (log += d)); ch.stderr.on("data", (d) => (log += d));
    ch.on("exit", (code) => resolve({ code, log }));
    ch.stdin.end(`${nueva}\n${nueva}\n`);
  });
  assert.equal(out.code, 0, out.log);
  assert.deepEqual(count(), before, "no se pierde ningún registro");

  const s2 = await startServer({ dbFile: s.dbFile });
  try {
    const old = client(s2.base);
    assert.equal((await old.login(ADMIN.email, ADMIN.password)).status, 401);
    const ok = client(s2.base);
    assert.equal((await ok.login(ADMIN.email, nueva)).status, 200);
    await completeMfa(ok, s2); // la recuperación de contraseña NO elimina el segundo factor
    // el cliente y su pedido siguen ahí
    assert.equal((await client(s2.base).login(USER.email, USER.password)).status, 200);
    assert.equal((await ok.req("GET", "/api/admin/orders")).data.length, 1);
  } finally { await s2.stop(); }
});

test("recuperación local: rechaza claves débiles y no modifica la base", async () => {
  const s = await startServer();
  await seedAdminAndUser(s);
  await s.stop();
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(ROOT, "scripts", "reset-admin-password.js")], { env: { ...process.env, MOCCI_DB: s.dbFile } });
    let log = "";
    ch.stdout.on("data", (d) => (log += d)); ch.stderr.on("data", (d) => (log += d));
    ch.on("exit", (code) => resolve({ code, log }));
    ch.stdin.end("corta1\ncorta1\n");
  });
  assert.notEqual(out.code, 0);
  const s2 = await startServer({ dbFile: s.dbFile });
  try { assert.equal((await client(s2.base).login(ADMIN.email, ADMIN.password)).status, 200); } finally { await s2.stop(); }
});

test("Fortress: cambiar la versión de sesión en SQLite invalida una sesión activa", async () => {
  const a = await loginAs(ADMIN);
  assert.equal((await a.req("GET", "/api/me")).data.user.role, "admin");
  const database = new DatabaseSync(srv.dbFile);
  database.prepare("UPDATE users SET session_version=session_version+1 WHERE email=?").run(ADMIN.email);
  database.close();
  assert.equal((await a.req("GET", "/api/me")).data.user, null);
});

test("Fortress: operaciones de producto quedan en registro de auditoría", async () => {
  const a = await loginAs(ADMIN);
  const created = await a.req("POST", "/api/products", NUEVO);
  assert.equal(created.status, 201);
  const logs = await a.req("GET", "/api/admin/audit");
  assert.equal(logs.status, 200);
  assert.ok(logs.data.some(x => x.action === "product_created" && x.target_id === created.data.id));
  const anon = await client(srv.base).req("GET", "/api/admin/audit");
  assert.equal(anon.status, 401);
});
