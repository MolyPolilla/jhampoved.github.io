"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { startServer, client, seedAdminAndUser, USER, ENVIO, PAGO_OK } = require("./helpers");
const { seal, unseal } = require("../lib/private-fields");
test("cifrado AES-GCM: autenticidad y texto plano con clave ausente", () => {
  assert.equal(unseal("texto anterior"), "texto anterior");
  assert.equal(seal("texto anterior"), "texto anterior");
});
test("con clave: perfil y dirección de pedido se cifran en SQLite, API los descifra", async () => {
  const key = crypto.randomBytes(32).toString("hex");
  const srv = await startServer({ env: { MOCCI_DATA_KEY: key } });
  try {
    await seedAdminAndUser(srv);
    const c = client(srv.base);
    assert.equal((await c.login(USER.email, USER.password)).status, 200);
    assert.equal((await c.req("PUT", "/api/profile", { nombre: "Cliente", telefono: "111222333", direccion: "Calle Nueva 45" })).status, 200);
    const p = (await c.req("GET", "/api/products")).data[0];
    const order = await c.req("POST", "/api/checkout", { items: [{ id: p.id, cantidad: 1 }], envio: ENVIO, pago: PAGO_OK });
    assert.equal(order.status, 201);
    assert.equal(order.data.pedido.envio.direccion, ENVIO.direccion);
    const db = new DatabaseSync(srv.dbFile);
    const user = db.prepare("SELECT direccion,telefono FROM users WHERE email=?").get(USER.email);
    const shipment = db.prepare("SELECT direccion_envio,envio_telefono FROM orders ORDER BY id DESC LIMIT 1").get();
    assert.match(user.direccion, /^enc:v1:/);
    assert.match(user.telefono, /^enc:v1:/);
    assert.match(shipment.direccion_envio, /^enc:v1:/);
    assert.match(shipment.envio_telefono, /^enc:v1:/);
    db.close();
  } finally { await srv.stop(); }
});
