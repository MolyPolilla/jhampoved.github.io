"use strict";
/* ==========================================================================
   MocciMoth v0.4 — servidor (Node 24 + node:sqlite, sin dependencias)
   Tienda FICTICIA para un laboratorio educativo de ciberseguridad.
   Los pagos son SIMULADOS: no se procesa ni se guarda ninguna tarjeta real.
   ========================================================================== */
const http = require("node:http");
const https = require("node:https");
const { seal, unseal } = require("./lib/private-fields");
const totp = require("./lib/totp");
const { createMfaSecrets } = require("./lib/mfa-secret");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.MOCCI_HOST || "127.0.0.1";
const TLS_CERT = process.env.MOCCI_TLS_CERT;
const TLS_KEY = process.env.MOCCI_TLS_KEY;
const USE_TLS = Boolean(TLS_CERT && TLS_KEY);
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) throw new Error("Configurá ambos: MOCCI_TLS_CERT y MOCCI_TLS_KEY.");
if (!USE_TLS && !["127.0.0.1", "::1", "localhost"].includes(HOST)) {
  throw new Error("Se prohíbe escuchar en la red sin HTTPS. Configurá TLS o usá 127.0.0.1.");
}
const PUB = path.join(__dirname, "public");
const UPLOADS = path.join(PUB, "uploads");
const DB_FILE = process.env.MOCCI_DB || path.join(__dirname, "moccimoth.db");
const db = new DatabaseSync(DB_FILE);
const mfaSecrets = createMfaSecrets(DB_FILE);
fs.mkdirSync(UPLOADS, { recursive: true });

/* --------------------------- Constantes de negocio ---------------------- */
const CATEGORIAS = ["Personajes", "Semi realistas", "Peluches", "Especiales"];
const MAX_POR_LINEA = 99;
const SESSION_MS = 8 * 60 * 60 * 1000; // 8 horas
const METODOS_PAGO = ["tarjeta", "transferencia", "billetera"];
// Solo se aceptan números de PRUEBA públicos. Una tarjeta real nunca pasa la validación.
const TARJETAS_DEMO = {
  "4242424242424242": "Visa",
  "4111111111111111": "Visa",
  "4000056655665556": "Visa",
  "5555555555554444": "Mastercard",
  "5105105105105100": "Mastercard",
  "378282246310005": "Amex",
};

/* Descuento escalonado por unidades TOTALES del carrito. */
function descuentoPct(unidades) {
  if (unidades >= 8) return 25;
  if (unidades >= 5) return 20;
  if (unidades >= 3) return 10;
  return 0;
}
function proximoEscalon(unidades) {
  for (const [min, pct] of [[3, 10], [5, 20], [8, 25]]) {
    if (unidades < min) return { faltan: min - unidades, pct };
  }
  return null;
}

/* ------------------------------ Base de datos --------------------------- */
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,telefono TEXT DEFAULT '',direccion TEXT DEFAULT '',fecha_nacimiento TEXT DEFAULT '',role TEXT DEFAULT 'user',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,descripcion TEXT NOT NULL,precio INTEGER NOT NULL,stock INTEGER NOT NULL,imagen TEXT DEFAULT '',categoria TEXT DEFAULT 'Peluches',updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,user_id INTEGER,total INTEGER,subtotal INTEGER,descuento INTEGER,unidades INTEGER,estado TEXT DEFAULT 'pago_simulado',payment_last4 TEXT,direccion_envio TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER,product_id INTEGER,nombre_snapshot TEXT,precio_snapshot INTEGER,cantidad INTEGER);`);

/* Migración suave: agrega columnas nuevas sin borrar tu base existente. */
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn("orders", "numero_pedido", "TEXT DEFAULT ''");
addColumn("orders", "metodo_pago", "TEXT DEFAULT 'tarjeta'");
addColumn("orders", "payment_brand", "TEXT DEFAULT ''");
addColumn("orders", "descuento_pct", "INTEGER DEFAULT 0");
addColumn("orders", "envio_nombre", "TEXT DEFAULT ''");
addColumn("orders", "envio_telefono", "TEXT DEFAULT ''");
addColumn("orders", "envio_ciudad", "TEXT DEFAULT ''");
addColumn("orders", "envio_provincia", "TEXT DEFAULT ''");
addColumn("orders", "envio_cp", "TEXT DEFAULT ''");
addColumn("order_items", "subtotal", "INTEGER DEFAULT 0");
addColumn("users", "session_version", "INTEGER NOT NULL DEFAULT 0");
// MFA TOTP (administradores): secreto cifrado, bandera, último paso usado (anti-replay) y códigos de recuperación con hash.
addColumn("users", "totp_secret_enc", "TEXT NOT NULL DEFAULT ''");
addColumn("users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "totp_last_step", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "recovery_hashes", "TEXT NOT NULL DEFAULT '[]'");
db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id INTEGER,
  details TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS suppliers (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory_receipts (
 id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
 supplier_id INTEGER REFERENCES suppliers(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
 reference TEXT NOT NULL UNIQUE, actor_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);
function audit(actor, action, targetType, targetId, details = '') {
  db.prepare("INSERT INTO audit_logs(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)")
    .run(actor, action, targetType, targetId ?? null, String(details).slice(0, 500));
}

if (!db.prepare("SELECT COUNT(*) n FROM products").get().n) {
  const ins = db.prepare("INSERT INTO products(nombre,descripcion,precio,stock,imagen,categoria) VALUES(?,?,?,?,?,?)");
  [
    ["Pompompurin Plush", "Peluche suave de personaje conocido.", 40000, 10, "/assets/productos/pompompurin.png", "Personajes"],
    ["Mocha Plush", "Peluche marrón de estilo kawaii.", 42000, 8, "/assets/productos/mocha.png", "Personajes"],
    ["Conejo Nube", "Conejo blanco de acabado semi realista.", 36000, 12, "/assets/productos/conejo.png", "Semi realistas"],
    ["Caballito Soft", "Caballo de peluche semi realista.", 46000, 6, "/assets/productos/caballo.png", "Semi realistas"],
    ["Abejita Pixel", "Peluche de abeja inspirado en estética de videojuego.", 32000, 14, "/assets/productos/abeja.png", "Personajes"],
  ].forEach((p) => ins.run(...p));
}

/* ------------------------------ Utilidades ------------------------------ */
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function verifyPassword(password, hash, salt) {
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(password, salt, 64));
  } catch {
    return false;
  }
}
const DUMMY = hashPassword("dummy-password-for-timing"); // iguala tiempos si el email no existe

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "El contenido enviado es demasiado grande.");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/* ---- Cookies según entorno ----
   - HTTP en localhost/127.0.0.1: cookie sin Secure (si no, el navegador la descartaría).
   - HTTPS (directo, o detrás de proxy con MOCCI_TRUST_PROXY=1 y X-Forwarded-Proto) o
     MOCCI_COOKIE_SECURE=1: se agrega Secure. */
function isHttps(req) {
  if (process.env.MOCCI_COOKIE_SECURE === "1") return true;
  if (req.socket && req.socket.encrypted) return true;
  return process.env.MOCCI_TRUST_PROXY === "1" && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
function cookieHeader(req, value, maxAgeSec) {
  return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}` + (isHttps(req) ? "; Secure" : "");
}

/* Sesiones en memoria con vencimiento. Cada sesión lleva su token CSRF y su estado MFA:
   un admin que solo puso la contraseña tiene una sesión "pendiente" (mfa=false) SIN ningún privilegio. */
const sessions = new Map(); // sid -> { userId, version, exp, csrf, mfa }
function startSession(req, res, userId, { mfa = true } = {}) {
  const sid = crypto.randomBytes(24).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  const row = db.prepare("SELECT session_version FROM users WHERE id=?").get(userId);
  sessions.set(sid, { userId, version: row.session_version, exp: Date.now() + SESSION_MS, csrf, mfa });
  res.setHeader("Set-Cookie", cookieHeader(req, sid, SESSION_MS / 1000));
  return csrf;
}
function endSessionsOf(userId, exceptSid) {
  for (const [sid, s] of sessions) if (s.userId === userId && sid !== exceptSid) sessions.delete(sid);
}
const qUserById = db.prepare("SELECT id,nombre,email,telefono,direccion,fecha_nacimiento,role FROM users WHERE id=?");
function userView(row) {
  return row && { ...row, telefono: unseal(row.telefono), direccion: unseal(row.direccion) };
}
/* Sesión vigente en cualquier estado MFA (comprueba vencimiento y session_version contra SQLite). */
function liveSession(req) {
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sid); return null; }
  const row = db.prepare("SELECT session_version FROM users WHERE id=?").get(s.userId);
  if (!row || row.session_version !== s.version) { sessions.delete(sid); return null; }
  return { sid, s };
}
/* Solo devuelve usuario si la sesión completó el MFA (o si no lo requiere). */
function currentUser(req) {
  const ls = liveSession(req);
  if (!ls || !ls.s.mfa) return null;
  return userView(qUserById.get(ls.s.userId)) || null;
}
const csrfTokenOf = (req) => { const ls = liveSession(req); return ls ? ls.s.csrf : null; };
const qMfaState = db.prepare("SELECT role,email,totp_enabled FROM users WHERE id=?");
const pendingOf = (ls) => { const u = qMfaState.get(ls.s.userId); return u && u.role === "admin" ? (u.totp_enabled ? "mfa" : "enroll") : null; };
/* Protección CSRF: toda operación autenticada que cambia datos exige el header
   X-CSRF-Token con el token de la sesión (además de la verificación de origen). */
function checkCsrf(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const expected = csrfTokenOf(req);
  const got = String(req.headers["x-csrf-token"] || "");
  const a = Buffer.from(got), b = Buffer.from(expected || "");
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new HttpError(403, "Token de seguridad inválido. Recargá la página e intentá de nuevo.", { code: "csrf" });
  }
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) {
    const ls = liveSession(req);
    if (ls && !ls.s.mfa) throw new HttpError(401, "Falta completar la verificación en dos pasos.", { code: "mfa_required" });
    throw new HttpError(401, "Iniciá sesión para continuar.");
  }
  checkCsrf(req);
  return u;
}
function requireAdmin(req) {
  const u = requireUser(req);
  if (u.role !== "admin") throw new HttpError(403, "Solo el administrador puede hacer esto.");
  return u;
}

/* Límite simple de intentos fallidos (login / cambio de contraseña). */
const attempts = new Map(); // key -> { n, until }
function checkLocked(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) {
    throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${Math.ceil((a.until - Date.now()) / 1000)} s.`);
  }
}
function registerFail(key, max = 5, lockMs = 60_000) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= max) {
    a.n = 0;
    a.until = Date.now() + lockMs;
  }
  attempts.set(key, a);
}
const clearFails = (key) => attempts.delete(key);

/* Límite por IP para operaciones públicas costosas; limpieza periódica. */
const rateBuckets = new Map();
function rateLimit(req, action, max, windowMs = 60_000) {
  const now = Date.now();
  const key = `${action}|${req.socket.remoteAddress}`;
  let entry = rateBuckets.get(key);
  if (!entry || entry.until <= now) entry = { count: 0, until: now + windowMs };
  entry.count++;
  rateBuckets.set(key, entry);
  if (entry.count > max) throw new HttpError(429, "Demasiadas solicitudes. Intentá de nuevo más tarde.");
  if (rateBuckets.size > 2000) for (const [k, v] of rateBuckets) if (v.until <= now) rateBuckets.delete(k);
}
/* Defensa CSRF: rechaza peticiones que cambian datos desde otro origen. */
function sameOriginOrThrow(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* origen inválido */ }
    if (host !== req.headers.host) throw new HttpError(403, "Origen no permitido.");
  } else if (req.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "Origen no permitido.");
  }
}

/* ------------------------------ Imágenes -------------------------------- */
const MAGIC = {
  png: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.length > 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")),
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || "");
  if (!m) throw new HttpError(400, "Imagen inválida (PNG, JPG, WEBP o GIF).");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 4e6) throw new HttpError(400, "La imagen supera los 4 MB.");
  if (!MAGIC[m[1]](buf)) throw new HttpError(400, "El archivo no coincide con su tipo de imagen.");
  const name = crypto.randomBytes(10).toString("hex") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return "/uploads/" + name;
}
function removeUploadIfOrphan(url) {
  if (!/^\/uploads\/[a-f0-9]{20}\.(png|jpg|webp|gif)$/.test(url || "")) return;
  const used = db.prepare("SELECT COUNT(*) n FROM products WHERE imagen=?").get(url).n;
  if (!used) fs.rmSync(path.join(PUB, url), { force: true });
}

/* ------------------------------ Productos ------------------------------- */
const qProduct = db.prepare("SELECT * FROM products WHERE id=?");

function parseProduct(b, imagenActual = "") {
  const errores = {};
  const nombre = String(b.nombre ?? "").trim();
  const descripcion = String(b.descripcion ?? "").trim();
  const precio = Number(b.precio);
  const stock = Number(b.stock);
  const categoria = String(b.categoria ?? "Peluches");
  if (nombre.length < 2 || nombre.length > 80) errores.nombre = "Nombre de 2 a 80 caracteres.";
  if (descripcion.length < 2 || descripcion.length > 300) errores.descripcion = "Descripción de 2 a 300 caracteres.";
  if (!Number.isInteger(precio) || precio < 0 || precio > 10_000_000) errores.precio = "Precio entero entre 0 y 10.000.000.";
  if (!Number.isInteger(stock) || stock < 0 || stock > 9999) errores.stock = "Stock entero entre 0 y 9999.";
  if (!CATEGORIAS.includes(categoria)) errores.categoria = "Categoría inválida.";
  let imagen = imagenActual;
  if (b.imageData) imagen = saveImage(b.imageData);
  else if (typeof b.imagen === "string" && b.imagen.trim()) {
    imagen = b.imagen.trim();
    if (!/^\/(assets|uploads)\/[\w\-./]+$/.test(imagen) || imagen.includes("..")) errores.imagen = "Ruta de imagen no válida.";
  }
  if (Object.keys(errores).length) throw new HttpError(400, "Revisá los campos del producto.", { errores });
  return { nombre, descripcion, precio, stock, categoria, imagen };
}

/* ------------------------------ Carrito --------------------------------- */
/* El servidor RECALCULA todo: precios, cantidades, stock y descuento.
   Del navegador solo se toman { id, cantidad }; el resto se ignora. */
function buildQuote(rawItems) {
  const merged = new Map();
  for (const it of (Array.isArray(rawItems) ? rawItems : []).slice(0, 100)) {
    const id = Number(it && it.id);
    const q = Math.floor(Number(it && it.cantidad));
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(q) || q <= 0) continue;
    merged.set(id, (merged.get(id) || 0) + q); // une líneas repetidas del mismo producto
  }
  const lineas = [];
  const avisos = [];
  for (const [id, pedida] of merged) {
    const p = qProduct.get(id);
    if (!p) {
      avisos.push({ id, tipo: "no_disponible", mensaje: "Un producto ya no está disponible y se quitó del carrito." });
      continue;
    }
    if (p.stock <= 0) {
      avisos.push({ id, tipo: "agotado", mensaje: `${p.nombre} está agotado y se quitó del carrito.` });
      continue;
    }
    const cantidad = Math.min(pedida, p.stock, MAX_POR_LINEA);
    if (cantidad < pedida) {
      avisos.push({ id, tipo: "stock", mensaje: `Solo hay ${cantidad} de ${p.nombre}; ajustamos la cantidad.` });
    }
    lineas.push({ id, nombre: p.nombre, imagen: p.imagen, precio: p.precio, stock: p.stock, cantidad, subtotal: p.precio * cantidad });
  }
  const unidades = lineas.reduce((a, l) => a + l.cantidad, 0);
  const subtotal = lineas.reduce((a, l) => a + l.subtotal, 0);
  const pct = descuentoPct(unidades);
  const descuento = Math.round((subtotal * pct) / 100);
  return { lineas, unidades, subtotal, descuento_pct: pct, descuento, total: subtotal - descuento, proximo: proximoEscalon(unidades), avisos };
}

/* ------------------------------ Checkout -------------------------------- */
const luhn = (num) => {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

function validateShipping(e = {}) {
  const errores = {};
  const v = (k) => String(e[k] ?? "").trim();
  const envio = { nombre: v("nombre"), telefono: v("telefono"), direccion: v("direccion"), ciudad: v("ciudad"), provincia: v("provincia"), cp: v("cp") };
  if (envio.nombre.length < 2 || envio.nombre.length > 60) errores["envio.nombre"] = "Ingresá un nombre (2 a 60 caracteres).";
  if (envio.telefono && !/^[0-9 +()-]{6,20}$/.test(envio.telefono)) errores["envio.telefono"] = "Teléfono no válido.";
  if (envio.direccion.length < 5 || envio.direccion.length > 100) errores["envio.direccion"] = "Ingresá una dirección (5 a 100 caracteres).";
  if (envio.ciudad.length < 2 || envio.ciudad.length > 60) errores["envio.ciudad"] = "Ingresá la ciudad.";
  if (envio.provincia.length < 2 || envio.provincia.length > 60) errores["envio.provincia"] = "Ingresá la provincia.";
  if (!/^[A-Za-z0-9 -]{3,10}$/.test(envio.cp)) errores["envio.cp"] = "Código postal no válido.";
  return { envio, errores };
}

function validatePayment(p = {}) {
  const errores = {};
  const metodo = String(p.metodo ?? "");
  if (!METODOS_PAGO.includes(metodo)) {
    errores["pago.metodo"] = "Elegí un método de pago.";
    return { metodo, last4: "DEMO", brand: "", errores };
  }
  if (metodo !== "tarjeta") return { metodo, last4: "DEMO", brand: metodo === "transferencia" ? "Transferencia demo" : "Billetera demo", errores };

  const t = p.tarjeta && typeof p.tarjeta === "object" ? p.tarjeta : {};
  const numero = String(t.numero ?? "").replace(/[\s-]/g, "");
  const titular = String(t.titular ?? "").trim();
  const venc = String(t.vencimiento ?? "").trim();
  const cvv = String(t.cvv ?? "");
  let last4 = "DEMO", brand = "";

  if (!/^\d{13,19}$/.test(numero) || !luhn(numero)) errores["pago.numero"] = "Número de tarjeta no válido.";
  else if (!TARJETAS_DEMO[numero]) errores["pago.numero"] = "Solo se aceptan tarjetas de PRUEBA (ej. 4242 4242 4242 4242). No uses una tarjeta real.";
  else { last4 = numero.slice(-4); brand = TARJETAS_DEMO[numero]; }

  if (titular.length < 2 || titular.length > 60 || !/^[\p{L} .'-]+$/u.test(titular)) errores["pago.titular"] = "Nombre del titular no válido.";

  const m = /^(\d{2})\/(\d{2})$/.exec(venc);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) errores["pago.vencimiento"] = "Usá el formato MM/AA.";
  else {
    const now = new Date();
    const y = 2000 + Number(m[2]);
    if (y < now.getFullYear() || (y === now.getFullYear() && Number(m[1]) < now.getMonth() + 1)) errores["pago.vencimiento"] = "La tarjeta demo está vencida.";
  }
  if (!/^\d{3,4}$/.test(cvv)) errores["pago.cvv"] = "El CVV demo tiene 3 o 4 dígitos.";
  // El número completo y el CVV se descartan acá: jamás se guardan ni se registran.
  return { metodo, last4, brand, errores };
}

const qOrder = db.prepare("SELECT * FROM orders WHERE id=?");
const qOrderItems = db.prepare("SELECT product_id,nombre_snapshot AS nombre,precio_snapshot AS precio,cantidad,subtotal FROM order_items WHERE order_id=? ORDER BY id");
function orderView(o) {
  return {
    id: o.id,
    numero_pedido: o.numero_pedido,
    estado: o.estado,
    created_at: o.created_at,
    metodo_pago: o.metodo_pago,
    marca: o.payment_brand,
    ultimos4: o.payment_last4,
    envio: { nombre: o.envio_nombre, telefono: unseal(o.envio_telefono), direccion: unseal(o.direccion_envio), ciudad: o.envio_ciudad, provincia: o.envio_provincia, cp: o.envio_cp },
    unidades: o.unidades,
    subtotal: o.subtotal,
    descuento_pct: o.descuento_pct,
    descuento: o.descuento,
    total: o.total,
    items: qOrderItems.all(o.id),
  };
}

function createOrder(user, body) {
  const quote = buildQuote(body.items);
  if (!quote.unidades) throw new HttpError(400, "Tu carrito está vacío.");
  // Si algo cambió (stock o precio) se avisa antes de cobrar nada.
  if (quote.avisos.length) throw new HttpError(409, "Tu carrito cambió por falta de stock. Revisalo e intentá de nuevo.", { quote });
  if (body.totalEsperado !== undefined && Number(body.totalEsperado) !== quote.total) {
    throw new HttpError(409, "Los precios o descuentos cambiaron. Revisá el total actualizado.", { quote });
  }

  const ship = validateShipping(body.envio);
  const pay = validatePayment(body.pago);
  const errores = { ...ship.errores, ...pay.errores };
  if (Object.keys(errores).length) throw new HttpError(400, "Revisá los campos marcados.", { errores });

  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db.prepare(
      `INSERT INTO orders(user_id,total,subtotal,descuento,descuento_pct,unidades,estado,metodo_pago,payment_brand,payment_last4,
        direccion_envio,envio_nombre,envio_telefono,envio_ciudad,envio_provincia,envio_cp)
       VALUES(?,?,?,?,?,?,'pago_simulado',?,?,?,?,?,?,?,?,?)`
    ).run(user.id, quote.total, quote.subtotal, quote.descuento, quote.descuento_pct, quote.unidades, pay.metodo, pay.brand, pay.last4,
      seal(ship.envio.direccion), ship.envio.nombre, seal(ship.envio.telefono), ship.envio.ciudad, ship.envio.provincia, ship.envio.cp);
    const orderId = Number(r.lastInsertRowid);
    const numero = `MM-${new Date().getFullYear()}-${String(orderId).padStart(6, "0")}`;
    db.prepare("UPDATE orders SET numero_pedido=? WHERE id=?").run(numero, orderId);

    const insItem = db.prepare("INSERT INTO order_items(order_id,product_id,nombre_snapshot,precio_snapshot,cantidad,subtotal) VALUES(?,?,?,?,?,?)");
    const dec = db.prepare("UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock>=?");
    for (const l of quote.lineas) {
      if (dec.run(l.cantidad, l.id, l.cantidad).changes !== 1) throw new HttpError(409, `Se agotó ${l.nombre} mientras comprabas.`);
      insItem.run(orderId, l.id, l.nombre, l.precio, l.cantidad, l.subtotal);
    }
    db.exec("COMMIT");
    return orderView(qOrder.get(orderId));
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/* ------------------------------ Validaciones de cuenta ------------------ */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const cleanText = (v, max) => String(v ?? "").trim().slice(0, max);

/* ------------------------------ Rutas ----------------------------------- */
const sha256hex = (x) => crypto.createHash("sha256").update(x).digest("hex");
const newRecoveryCode = () => { const c = totp.base32Encode(crypto.randomBytes(7)).slice(0, 10); return c.slice(0, 5) + "-" + c.slice(5); };
const hashRecovery = (c) => sha256hex("recovery:" + String(c).replace(/[\s-]/g, "").toUpperCase());
function mfaSecretOf(row, uid) {
  try { return mfaSecrets.reveal(row.totp_secret_enc, uid); } catch (e) {
    console.error("MFA: no se pudo descifrar el secreto:", e.message);
    throw new HttpError(500, "No se pudo leer la clave de verificación (¿falta MOCCI_DATA_KEY o el archivo .mfa.key?). Recuperación local: npm run reset-admin -- --reset-mfa");
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  sameOriginOrThrow(req);

  if (p === "/api/setup-status" && m === "GET") {
    return send(res, 200, {
      needsSetup: !db.prepare("SELECT id FROM users WHERE role='admin'").get(),
      setupTokenRequired: process.env.MOCCI_TRUST_PROXY === "1",
    });
  }
  if (p === "/api/setup-admin" && m === "POST") {
    if (db.prepare("SELECT id FROM users WHERE role='admin'").get()) throw new HttpError(409, "El administrador ya está configurado.");
    const b = await readJson(req);
    if (process.env.MOCCI_TRUST_PROXY === "1") {
      const expected = Buffer.from(process.env.MOCCI_SETUP_TOKEN || "");
      const provided = Buffer.from(String(b.setupToken || ""));
      if (!expected.length || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        throw new HttpError(403, "Token de configuración inválido.");
      }
    } else if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
      throw new HttpError(403, "La configuración inicial del administrador es exclusivamente local.");
    }
    const email = cleanText(b.email, 254).toLowerCase();
    if (cleanText(b.nombre, 60).length < 2 || !EMAIL_RE.test(email) || String(b.password || "").length < 8) {
      throw new HttpError(400, "Completá nombre, email válido y una clave de 8+ caracteres.");
    }
    const x = hashPassword(String(b.password));
    try {
      db.prepare("INSERT INTO users(nombre,email,password_hash,salt,role) VALUES(?,?,?,?,'admin')").run(cleanText(b.nombre, 60), email, x.hash, x.salt);
    } catch { throw new HttpError(409, "Ese correo ya existe."); }
    delete process.env.MOCCI_SETUP_TOKEN;
    return send(res, 201, { ok: true });
  }

  /* --- Catálogo y carrito (públicos) --- */
  if (p === "/api/products" && m === "GET") return send(res, 200, db.prepare("SELECT * FROM products ORDER BY id").all());
  if (p === "/api/cart/quote" && m === "POST") {
    const b = await readJson(req);
    return send(res, 200, buildQuote(b.items));
  }

  /* --- Cuenta --- */
  if (p === "/api/me" && m === "GET") {
    const user = currentUser(req);
    if (user) return send(res, 200, { user, csrfToken: csrfTokenOf(req), pending: null });
    const ls = liveSession(req);
    if (ls && !ls.s.mfa) return send(res, 200, { user: null, csrfToken: ls.s.csrf, pending: pendingOf(ls) });
    return send(res, 200, { user: null, csrfToken: null, pending: null });
  }
  if (p === "/api/register" && m === "POST") {
    rateLimit(req, "register", 10);
    const b = await readJson(req);
    const email = cleanText(b.email, 254).toLowerCase();
    if (cleanText(b.nombre, 60).length < 2 || !EMAIL_RE.test(email) || String(b.password || "").length < 8) {
      throw new HttpError(400, "Revisá los datos (la contraseña debe tener 8+ caracteres).");
    }
    const x = hashPassword(String(b.password));
    try {
      db.prepare("INSERT INTO users(nombre,email,password_hash,salt,telefono,direccion,fecha_nacimiento) VALUES(?,?,?,?,?,?,?)")
        .run(cleanText(b.nombre, 60), email, x.hash, x.salt, seal(cleanText(b.telefono, 20)), seal(cleanText(b.direccion, 100)), cleanText(b.fecha_nacimiento, 10));
    } catch { throw new HttpError(409, "Ese correo ya existe."); }
    return send(res, 201, { ok: true });
  }
  if (p === "/api/login" && m === "POST") {
    rateLimit(req, "login", 20);
    const b = await readJson(req);
    const email = cleanText(b.email, 254).toLowerCase();
    const key = `login|${req.socket.remoteAddress}|${email}`;
    checkLocked(key);
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    const ok = u ? verifyPassword(String(b.password || ""), u.password_hash, u.salt) : (verifyPassword("x", DUMMY.hash, DUMMY.salt), false);
    if (!ok) { registerFail(key); throw new HttpError(401, "Datos incorrectos."); }
    clearFails(key);
    const isAdmin = u.role === "admin";
    const csrfToken = startSession(req, res, u.id, { mfa: !isAdmin }); // el admin queda pendiente hasta su segundo factor
    return send(res, 200, { ok: true, csrfToken, pending: isAdmin ? (u.totp_enabled ? "mfa" : "enroll") : null });
  }
  if (p === "/api/login/mfa" && m === "POST") {
    rateLimit(req, "mfa", 30);
    const ls = liveSession(req);
    const st = ls && qMfaState.get(ls.s.userId);
    if (!ls || ls.s.mfa || !st || !st.totp_enabled) throw new HttpError(401, "No hay una verificación pendiente. Iniciá sesión de nuevo.");
    checkCsrf(req);
    const uid = ls.s.userId;
    const key = `mfa|${uid}`;
    checkLocked(key);
    const code = String((await readJson(req)).code ?? "").trim();
    const row = db.prepare("SELECT totp_secret_enc,totp_last_step,recovery_hashes FROM users WHERE id=?").get(uid);
    let ok = false, usedRecovery = false, left = null;
    if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
      const step = totp.verify(mfaSecretOf(row, uid), code, { lastStep: row.totp_last_step });
      if (step) { db.prepare("UPDATE users SET totp_last_step=? WHERE id=?").run(step, uid); ok = true; }
    } else if (code) {
      const list = JSON.parse(row.recovery_hashes || "[]");
      const h = hashRecovery(code);
      const i = list.findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
      if (i >= 0) { list.splice(i, 1); left = list.length; db.prepare("UPDATE users SET recovery_hashes=? WHERE id=?").run(JSON.stringify(list), uid); ok = usedRecovery = true; }
    }
    if (!ok) {
      registerFail(key, 5, 5 * 60_000);
      audit(uid, "mfa_failed", "user", uid, "código incorrecto");
      throw new HttpError(401, "Código incorrecto.");
    }
    clearFails(key);
    sessions.delete(ls.sid); // nueva sesión (nuevo sid y nuevo token CSRF) al subir de nivel
    const csrfToken = startSession(req, res, uid, { mfa: true });
    audit(uid, usedRecovery ? "mfa_recovery_used" : "mfa_login_ok", "user", uid, usedRecovery ? `quedan ${left} códigos` : "");
    return send(res, 200, { ok: true, csrfToken, recoveryLeft: left });
  }
  if ((p === "/api/admin/mfa/setup" || p === "/api/admin/mfa/enable") && m === "POST") {
    rateLimit(req, "mfa", 30);
    const ls = liveSession(req);
    if (!ls) throw new HttpError(401, "Iniciá sesión para continuar.");
    const st = qMfaState.get(ls.s.userId);
    if (!st || st.role !== "admin") throw new HttpError(403, "Solo el administrador puede hacer esto.");
    if (st.totp_enabled) throw new HttpError(409, "La verificación en dos pasos ya está activa.");
    checkCsrf(req);
    const uid = ls.s.userId;
    if (p.endsWith("/setup")) {
      const secret = totp.newSecret();
      db.prepare("UPDATE users SET totp_secret_enc=? WHERE id=?").run(mfaSecrets.protect(secret, uid), uid); // cifrado, nunca en claro
      return send(res, 200, { secret, otpauth: totp.otpauthUri(secret, st.email) });
    }
    const row = db.prepare("SELECT totp_secret_enc FROM users WHERE id=?").get(uid);
    if (!row.totp_secret_enc) throw new HttpError(409, "Primero generá la clave de verificación.");
    const key = `mfa|${uid}`;
    checkLocked(key);
    const step = totp.verify(mfaSecretOf(row, uid), String((await readJson(req)).code ?? ""), { lastStep: 0 });
    if (!step) {
      registerFail(key, 5, 5 * 60_000);
      audit(uid, "mfa_enroll_failed", "user", uid, "código incorrecto");
      throw new HttpError(400, "Código incorrecto. Revisá la hora de tu celular y probá con el código nuevo.");
    }
    clearFails(key);
    const codes = Array.from({ length: 8 }, newRecoveryCode);
    db.prepare("UPDATE users SET totp_enabled=1,totp_last_step=?,recovery_hashes=?,session_version=session_version+1 WHERE id=?")
      .run(step, JSON.stringify(codes.map(hashRecovery)), uid);
    sessions.delete(ls.sid);
    endSessionsOf(uid); // cualquier otra sesión previa queda invalidada
    const csrfToken = startSession(req, res, uid, { mfa: true });
    audit(uid, "mfa_enabled", "user", uid);
    return send(res, 200, { ok: true, csrfToken, recoveryCodes: codes }); // se muestran UNA sola vez
  }
  if (p === "/api/logout" && m === "POST") {
    if (liveSession(req)) checkCsrf(req); // un tercero no puede cerrarte la sesión (también si está pendiente de MFA)
    sessions.delete(parseCookies(req).sid);
    res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
    return send(res, 200, { ok: true });
  }
  if (p === "/api/profile" && m === "PUT") {
    const u = requireUser(req);
    const b = await readJson(req);
    db.prepare("UPDATE users SET nombre=?,telefono=?,direccion=?,fecha_nacimiento=? WHERE id=?")
      .run(cleanText(b.nombre, 60) || u.nombre, seal(cleanText(b.telefono, 20)), seal(cleanText(b.direccion, 100)), cleanText(b.fecha_nacimiento, 10), u.id);
    return send(res, 200, { ok: true });
  }

  /* --- Administrador: contraseña --- */
  if (p === "/api/admin/password" && m === "POST") {
    const admin = requireAdmin(req);
    const b = await readJson(req);
    const key = `pwd|${admin.id}`;
    checkLocked(key);
    const row = db.prepare("SELECT password_hash,salt FROM users WHERE id=?").get(admin.id);
    const actual = String(b.actual ?? ""), nueva = String(b.nueva ?? ""), confirmar = String(b.confirmar ?? "");
    if (!verifyPassword(actual, row.password_hash, row.salt)) {
      registerFail(key);
      throw new HttpError(400, "La contraseña actual no es correcta.", { errores: { actual: "La contraseña actual no es correcta." } });
    }
    const errores = {};
    if (nueva.length < 10) errores.nueva = "Usá al menos 10 caracteres.";
    else if (!/[A-Za-z]/.test(nueva) || !/\d/.test(nueva)) errores.nueva = "Combiná letras y números.";
    else if (nueva === actual) errores.nueva = "La nueva contraseña debe ser distinta de la actual.";
    else if (nueva.toLowerCase().includes(admin.email.split("@")[0].toLowerCase())) errores.nueva = "No uses tu email dentro de la contraseña.";
    if (nueva !== confirmar) errores.confirmar = "Las contraseñas no coinciden.";
    if (Object.keys(errores).length) throw new HttpError(400, "Revisá los campos.", { errores });
    clearFails(key);
    const x = hashPassword(nueva);
    db.prepare("UPDATE users SET password_hash=?,salt=?,session_version=session_version+1 WHERE id=?").run(x.hash, x.salt, admin.id);
    audit(admin.id, "password_changed", "user", admin.id);
    // Cierra todas las sesiones anteriores y abre una nueva para este navegador.
    endSessionsOf(admin.id);
    sessions.delete(parseCookies(req).sid);
    const csrfToken = startSession(req, res, admin.id, { mfa: true });
    return send(res, 200, { ok: true, csrfToken });
  }

  /* --- Productos (solo admin escribe) --- */
  const pm = /^\/api\/products\/(\d+)(\/stock)?$/.exec(p);
  if (p === "/api/products" && m === "POST") {
    requireAdmin(req);
    const d = parseProduct(await readJson(req, 8e6));
    const r = db.prepare("INSERT INTO products(nombre,descripcion,precio,stock,imagen,categoria) VALUES(?,?,?,?,?,?)")
      .run(d.nombre, d.descripcion, d.precio, d.stock, d.imagen, d.categoria);
    audit(currentUser(req).id, "product_created", "product", Number(r.lastInsertRowid));
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if (pm && !pm[2] && m === "PUT") {
    requireAdmin(req);
    const old = qProduct.get(Number(pm[1]));
    if (!old) throw new HttpError(404, "Producto inexistente.");
    const d = parseProduct(await readJson(req, 8e6), old.imagen);
    db.prepare("UPDATE products SET nombre=?,descripcion=?,precio=?,stock=?,imagen=?,categoria=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(d.nombre, d.descripcion, d.precio, d.stock, d.imagen, d.categoria, old.id);
    audit(currentUser(req).id, "product_updated", "product", old.id, `precio ${old.precio} -> ${d.precio}; stock ${old.stock} -> ${d.stock}`);
    if (old.imagen !== d.imagen) removeUploadIfOrphan(old.imagen);
    return send(res, 200, { ok: true });
  }
  if (pm && pm[2] && m === "PATCH") {
    requireAdmin(req);
    const old = qProduct.get(Number(pm[1]));
    if (!old) throw new HttpError(404, "Producto inexistente.");
    const stock = Number((await readJson(req)).stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 9999) throw new HttpError(400, "Stock entero entre 0 y 9999.");
    db.prepare("UPDATE products SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(stock, old.id);
    audit(currentUser(req).id, "stock_updated", "product", old.id, `${old.stock} -> ${stock}`);
    return send(res, 200, { ok: true, stock });
  }
  if (pm && !pm[2] && m === "DELETE") {
    requireAdmin(req);
    const old = qProduct.get(Number(pm[1]));
    if (!old) throw new HttpError(404, "Producto inexistente.");
    db.prepare("DELETE FROM products WHERE id=?").run(old.id);
    audit(currentUser(req).id, "product_deleted", "product", old.id, old.nombre);
    removeUploadIfOrphan(old.imagen);
    return send(res, 200, { ok: true });
  }

  /* --- Checkout y pedidos --- */
  if (p === "/api/checkout" && m === "POST") {
    rateLimit(req, "checkout", 20);
    const u = requireUser(req);
    // Aviso explícito: nunca enviar datos reales. El servidor igual los rechaza.
    const pedido = createOrder(u, await readJson(req));
    return send(res, 201, { ok: true, pedido });
  }
  if (p === "/api/orders" && m === "GET") {
    const u = requireUser(req);
    return send(res, 200, db.prepare("SELECT id,numero_pedido,created_at,total,unidades,estado FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 50").all(u.id));
  }
  const om = /^\/api\/orders\/(\d+)$/.exec(p);
  if (om && m === "GET") {
    const u = requireUser(req);
    const o = qOrder.get(Number(om[1]));
    if (!o || (o.user_id !== u.id && u.role !== "admin")) throw new HttpError(404, "Pedido no encontrado.");
    return send(res, 200, orderView(o));
  }
  if (p === "/api/admin/orders" && m === "GET") {
    requireAdmin(req);
    return send(res, 200, db.prepare(
      `SELECT o.id,o.numero_pedido,o.created_at,o.total,o.unidades,o.estado,u.nombre,u.email
       FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 50`).all());
  }

  /* --- Mocci Lab: operaciones exclusivamente administrativas --- */
  if (p.startsWith("/api/lab/")) {
    const admin = requireAdmin(req);
    if (p === "/api/lab/overview" && m === "GET") {
      const summary = db.prepare(`SELECT COUNT(*) products, COALESCE(SUM(stock),0) units,
        SUM(CASE WHEN stock<=3 THEN 1 ELSE 0 END) low_stock FROM products`).get();
      const orders = db.prepare("SELECT COUNT(*) orders,COALESCE(SUM(total),0) revenue_demo FROM orders").get();
      const suppliers = db.prepare("SELECT COUNT(*) n FROM suppliers WHERE active=1").get().n;
      const top = db.prepare(`SELECT product_id,nombre_snapshot name,SUM(cantidad) units
        FROM order_items GROUP BY product_id ORDER BY units DESC LIMIT 5`).all();
      return send(res, 200, { ...summary, ...orders, suppliers, top });
    }
    if (p === "/api/lab/suppliers" && m === "GET")
      return send(res, 200, db.prepare("SELECT * FROM suppliers ORDER BY name LIMIT 300").all());
    if (p === "/api/lab/suppliers" && m === "POST") {
      const b = await readJson(req);
      const name = cleanText(b.name, 100), contact = cleanText(b.contact, 120), notes = cleanText(b.notes, 300);
      if (name.length < 2) throw new HttpError(400, "Nombre del proveedor demasiado corto.");
      const r = db.prepare("INSERT INTO suppliers(name,contact,notes) VALUES(?,?,?)").run(name, contact, notes);
      audit(admin.id, "supplier_created", "supplier", Number(r.lastInsertRowid), name);
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    }
    const supplierMatch = /^\/api\/lab\/suppliers\/(\d+)$/.exec(p);
    if (supplierMatch && m === "PATCH") {
      const id = Number(supplierMatch[1]), b = await readJson(req);
      const old = db.prepare("SELECT * FROM suppliers WHERE id=?").get(id);
      if (!old) throw new HttpError(404, "Proveedor inexistente.");
      const name = cleanText(b.name ?? old.name, 100);
      if (name.length < 2 || (b.active !== undefined && ![true,false,0,1].includes(b.active))) throw new HttpError(400, "Datos inválidos.");
      db.prepare("UPDATE suppliers SET name=?,contact=?,notes=?,active=? WHERE id=?")
        .run(name,cleanText(b.contact ?? old.contact,120),cleanText(b.notes ?? old.notes,300),b.active === undefined ? old.active : Number(Boolean(b.active)),id);
      audit(admin.id,"supplier_updated","supplier",id,name);
      return send(res,200,{ok:true});
    }
    if (p === "/api/lab/receipts" && m === "GET")
      return send(res,200,db.prepare(`SELECT r.id,r.product_id,p.nombre product_name,r.supplier_id,
        s.name supplier_name,r.quantity,r.reference,r.created_at
        FROM inventory_receipts r JOIN products p ON p.id=r.product_id
        LEFT JOIN suppliers s ON s.id=r.supplier_id ORDER BY r.id DESC LIMIT 100`).all());
    if (p === "/api/lab/receipts" && m === "POST") {
      const b = await readJson(req);
      const productId = Number(b.product_id), supplierId = b.supplier_id === null || b.supplier_id === '' || b.supplier_id === undefined ? null : Number(b.supplier_id);
      const qty = Number(b.quantity), reference = cleanText(b.reference, 80);
      if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(qty) || qty < 1 || qty > 9999 || reference.length < 3)
        throw new HttpError(400,"Producto, cantidad o referencia inválidos.");
      if (supplierId !== null && (!Number.isSafeInteger(supplierId) || !db.prepare("SELECT id FROM suppliers WHERE id=? AND active=1").get(supplierId)))
        throw new HttpError(400,"Proveedor inexistente o inactivo.");
      const old = db.prepare("SELECT id,stock FROM products WHERE id=?").get(productId);
      if (!old) throw new HttpError(404,"Producto inexistente.");
      if (old.stock + qty > 9999) throw new HttpError(400,"La recepción supera el máximo de stock.");
      // Transacción: la referencia única evita registrar dos veces la misma entrega.
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare("INSERT INTO inventory_receipts(product_id,supplier_id,quantity,reference,actor_id) VALUES(?,?,?,?,?)")
          .run(productId,supplierId,qty,reference,admin.id);
        const updated = db.prepare("UPDATE products SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock+?<=9999").run(qty,productId,qty);
        if (updated.changes !== 1) throw new HttpError(409,"Stock modificado; volvé a intentar.");
        audit(admin.id,"stock_received","product",productId,`+${qty}; referencia ${reference}`);
        db.exec("COMMIT");
        return send(res,201,{ok:true,id:Number(r.lastInsertRowid),stock:old.stock+qty});
      } catch(e) {
        db.exec("ROLLBACK");
        if (String(e.message).includes("UNIQUE constraint failed: inventory_receipts.reference")) throw new HttpError(409,"Esa referencia de recepción ya fue registrada.");
        throw e;
      }
    }
    throw new HttpError(404,"Ruta del laboratorio inexistente.");
  }

  if (p === "/api/admin/audit" && m === "GET") {
    requireAdmin(req);
    return send(res, 200, db.prepare("SELECT id,actor_id,action,target_type,target_id,details,created_at FROM audit_logs ORDER BY id DESC LIMIT 100").all());
  }
  throw new HttpError(404, "Ruta inexistente.");
}

/* ------------------------------ Archivos estáticos ---------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
function serveStatic(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method)) return false;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(PUB, pathname));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) return false; // evita salir de /public
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  if (req.method === "HEAD") return res.end(), true;
  const stream = fs.createReadStream(file);
  stream.on("error", () => { if (!res.headersSent) res.writeHead(500); res.destroy(); });
  stream.pipe(res);
  return true;
}

/* ------------------------------ Servidor -------------------------------- */
const handler = async (req, res) => {
  if (USE_TLS) res.setHeader("Strict-Transport-Security", "max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (serveStatic(req, res, url)) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 — no encontrado");
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
    console.error("Error interno:", e.message); // nunca se registran cuerpos de petición
    send(res, 500, { error: "Error interno del servidor." });
  }
};
const server = USE_TLS
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: "TLSv1.2" }, handler)
  : http.createServer(handler);
server.listen(PORT, HOST, () => console.log(`🦋 MocciMoth Fortress v0.5.2 → ${USE_TLS ? "https" : "http"}://${HOST}:${PORT}`));
