/* MocciMoth — utilidades compartidas: íconos, API, toasts, barra superior y carrito.
   Se carga en TODAS las páginas antes del script propio de cada una. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const money = (n) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n || 0);

/* ---------- Íconos (sprite estilo Lucide en /icons.svg) ---------- */
const ic = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
function hydrateIcons(root = document) {
  $$("i[data-icon]", root).forEach((el) => {
    el.outerHTML = ic(el.dataset.icon, el.className || "");
  });
}

/* ---------- API: nunca lanza; devuelve { ok, status, data } ----------
   CSRF: el token de la sesión viene en /api/me, /api/login y /api/admin/password.
   Se envía en el header X-CSRF-Token en todo método que cambia datos. */
let csrfToken = null, csrfTried = false;
async function api(method, url, body, _retried = false) {
  const mutating = method !== "GET" && method !== "HEAD";
  try {
    const headers = body !== undefined ? { "Content-Type": "application/json" } : {};
    if (mutating) {
      if (!csrfToken && !csrfTried) {
        csrfTried = true;
        try { csrfToken = (await (await fetch("/api/me")).json()).csrfToken || null; } catch { /* sin token */ }
      }
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    }
    const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch { /* sin cuerpo */ }
    if (data && typeof data.csrfToken === "string") csrfToken = data.csrfToken;
    if (r.status === 403 && data.code === "csrf" && !_retried) { // token vencido: se pide uno nuevo y se reintenta una vez
      csrfToken = null; csrfTried = false;
      return api(method, url, body, true);
    }
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "No se pudo conectar con el servidor. ¿Está corriendo `npm start`?" } };
  }
}

/* ---------- Toasts ---------- */
function toast(msg, type = "ok") {
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.innerHTML = ic(type === "err" ? "circle-alert" : type === "info" ? "info" : "circle-check") + `<span>${esc(msg)}</span>`;
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), 3200);
  setTimeout(() => t.remove(), 3600);
}

/* ---------- Estado de carga en botones ---------- */
function setLoading(btn, on, text) {
  if (!btn) return;
  if (on) {
    btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = ic("loader", "spin") + `<span>${esc(text || "Procesando…")}</span>`;
  } else {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
  }
}

/* =====================================================================
   CARRITO
   El navegador solo guarda { id: cantidad } en localStorage. Todo precio,
   descuento, stock y total que se muestra viene de POST /api/cart/quote.
   ===================================================================== */
const Cart = (() => {
  const KEY = "mocciCart";
  let lastQuote = null;
  let seq = 0;

  const read = () => {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || "{}");
      const clean = {};
      for (const [id, q] of Object.entries(o)) if (Number.isInteger(+id) && +q > 0) clean[id] = Math.floor(+q);
      return clean;
    } catch { return {}; }
  };
  const write = (o) => {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* modo privado */ }
    window.dispatchEvent(new CustomEvent("cart:changed"));
  };
  const count = () => Object.values(read()).reduce((a, b) => a + b, 0);

  return {
    read, count,
    get last() { return lastQuote; },
    items: () => Object.entries(read()).map(([id, cantidad]) => ({ id: +id, cantidad })),
    add(id, n = 1) { const c = read(); c[id] = (c[id] || 0) + n; write(c); },
    set(id, n) { const c = read(); if (n > 0) c[id] = n; else delete c[id]; write(c); },
    remove(id) { const c = read(); delete c[id]; write(c); },
    clear() { write({}); },
    /* Pide al servidor el cálculo oficial y reconcilia el carrito local con él. */
    async quote({ silent = false } = {}) {
      const mine = ++seq;
      const items = this.items();
      if (!items.length) {
        lastQuote = { lineas: [], unidades: 0, subtotal: 0, descuento: 0, descuento_pct: 0, total: 0, proximo: { faltan: 3, pct: 10 }, avisos: [] };
        return lastQuote;
      }
      const r = await api("POST", "/api/cart/quote", { items });
      if (mine !== seq) return lastQuote; // llegó una respuesta más nueva
      if (!r.ok) { if (!silent) toast(r.data.error || "No se pudo calcular el carrito.", "err"); return lastQuote; }
      lastQuote = r.data;
      const next = {};
      lastQuote.lineas.forEach((l) => (next[l.id] = l.cantidad));
      const before = JSON.stringify(read());
      if (JSON.stringify(next) !== before) {
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent("cart:changed", { detail: { reconciled: true } }));
      }
      if (!silent) lastQuote.avisos.forEach((a) => toast(a.mensaje, "info"));
      return lastQuote;
    },
  };
})();

/* ---------- Barra superior ---------- */
const isCheckout = location.pathname.endsWith("/checkout.html");
function renderHeader() {
  const h = $("#top");
  if (!h) return;
  h.innerHTML = `<div class="wrap nav">
    <a class="brand" href="/" aria-label="MocciMoth, inicio"><img class="gif" src="/assets/gifs/mariposa.gif" alt="" width="33" height="24"><span>Mocci<b>Moth</b></span></a>
    <a class="navlink" href="/#peluches">${ic("store")}<span>Peluches</span></a>
    <a class="navlink" href="/#nosotros">${ic("sparkles")}<span>Nosotros</span></a>
    <a class="navlink" href="/cuenta.html" id="navUser">${ic("user")}<span>Mi cuenta</span></a>
    <button class="btn nav-cart" id="cartBtn" type="button" aria-label="Abrir carrito">${ic("shopping-cart")}<span class="hide-sm">Carrito</span><span class="badge" id="cartCount">0</span></button>
  </div>`;
  $("#cartBtn").addEventListener("click", openCart);
  updateBadge();
  api("GET", "/api/me").then((r) => {
    const u = r.data && r.data.user;
    if (u) $("#navUser span").textContent = u.nombre.split(" ")[0];
  });
}
function updateBadge() {
  const b = $("#cartCount");
  if (!b) return;
  const n = Cart.count();
  b.textContent = n > 99 ? "99+" : n;
  b.classList.toggle("zero", n === 0);
}

/* ---------- Cajón del carrito ---------- */
function buildDrawer() {
  if ($("#cartDrawer")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="overlay" id="cartOverlay"></div>
    <aside class="drawer" id="cartDrawer" role="dialog" aria-modal="true" aria-label="Carrito de compras" aria-hidden="true">
      <div class="drawer-head"><h2>${ic("shopping-cart", "i-lg")} Tu carrito</h2><button class="icon-btn" id="closeCart" type="button" aria-label="Cerrar carrito">${ic("x")}</button></div>
      <div class="drawer-body" id="cartBody"></div>
      <div class="drawer-foot" id="cartFoot"></div>
    </aside>`);
  $("#cartOverlay").addEventListener("click", closeCart);
  $("#closeCart").addEventListener("click", closeCart);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCart(); });

  $("#cartDrawer").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return closeCart();
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const line = b.closest("[data-id]");
    const id = line ? +line.dataset.id : 0;
    const q = Cart.read()[id] || 0;
    if (b.dataset.act === "inc") Cart.set(id, q + 1);
    else if (b.dataset.act === "dec") Cart.set(id, q - 1);
    else if (b.dataset.act === "del") Cart.remove(id);
    else if (b.dataset.act === "clear") {
      if (confirm("¿Vaciar todo el carrito?")) { Cart.clear(); toast("Carrito vacío.", "info"); }
    }
  });
  $("#cartDrawer").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-qty]");
    if (inp) Cart.set(+inp.closest("[data-id]").dataset.id, Math.max(0, Math.floor(+inp.value || 0)));
  });
}

let drawerTimer = 0;
async function renderCart() {
  updateBadge();
  const body = $("#cartBody"), foot = $("#cartFoot");
  if (!body) return;
  const q = await Cart.quote();
  updateBadge();
  if (!q.lineas.length) {
    body.innerHTML = `<div class="empty"><img class="gif big" src="/assets/gifs/gatito.gif" alt="" width="60" height="60"><p><b>Tu carrito está dramáticamente vacío</b></p><p class="muted">Agregá peluches desde el catálogo.</p></div>`;
    foot.innerHTML = `<a class="btn" href="/#peluches" data-close>${ic("store")}Ver peluches</a>`;
    return;
  }
  body.innerHTML = q.lineas.map((l) => `
    <div class="cart-line" data-id="${l.id}">
      ${l.imagen ? `<img src="${esc(l.imagen)}" alt="${esc(l.nombre)}">` : `<div class="noimg">${ic("package")}</div>`}
      <div class="cl-info">
        <b class="cl-name">${esc(l.nombre)}</b>
        <span class="muted">${money(l.precio)} c/u</span>
        <div class="stepper" role="group" aria-label="Cantidad de ${esc(l.nombre)}">
          <button type="button" data-act="dec" aria-label="Disminuir cantidad">${ic("minus", "i-sm")}</button>
          <input data-qty type="number" min="0" max="${l.stock}" value="${l.cantidad}" aria-label="Cantidad">
          <button type="button" data-act="inc" aria-label="Aumentar cantidad" ${l.cantidad >= l.stock ? "disabled" : ""}>${ic("plus", "i-sm")}</button>
        </div>
        ${l.cantidad >= l.stock ? `<span class="stock-note">${ic("info", "i-sm")} Máximo disponible (${l.stock})</span>` : ""}
      </div>
      <div class="cl-side"><b>${money(l.subtotal)}</b><button class="icon-btn sm" type="button" data-act="del" aria-label="Quitar ${esc(l.nombre)}">${ic("trash-2", "i-sm")}</button></div>
    </div>`).join("");

  const prog = Math.min(100, Math.round((q.unidades / 8) * 100));
  foot.innerHTML = `
    <div class="tier-hint">${ic("percent", "i-sm")} ${q.proximo ? `Sumá <b>${q.proximo.faltan}</b> más para <b>${q.proximo.pct}% OFF</b>` : "¡Tenés el descuento máximo (25%)!"}
      <div class="bar"><span style="width:${prog}%"></span></div></div>
    <dl class="totals">
      <div><dt>Subtotal (${q.unidades} u.)</dt><dd>${money(q.subtotal)}</dd></div>
      <div class="disc ${q.descuento ? "" : "off"}"><dt>${ic("tag", "i-sm")} Descuento ${q.descuento_pct}%</dt><dd>−${money(q.descuento)}</dd></div>
      <div class="grand"><dt>Total</dt><dd>${money(q.total)}</dd></div>
    </dl>
    <div class="foot-actions">
      ${isCheckout ? `<button class="btn" type="button" id="backToCheckout">${ic("check")}Seguir con el pago</button>` : `<a class="btn" href="/checkout.html">${ic("credit-card")}Finalizar compra</a>`}
      <button class="btn dark" type="button" data-act="clear">${ic("trash-2")}Vaciar</button>
    </div>`;
  const back = $("#backToCheckout");
  if (back) back.addEventListener("click", closeCart);
}
function openCart() {
  buildDrawer();
  $("#cartOverlay").classList.add("show");
  $("#cartDrawer").classList.add("open");
  $("#cartDrawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("noscroll");
  renderCart();
  setTimeout(() => $("#closeCart").focus(), 50);
}
function closeCart() {
  const d = $("#cartDrawer");
  if (!d) return;
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
  $("#cartOverlay").classList.remove("show");
  document.body.classList.remove("noscroll");
}

window.addEventListener("cart:changed", () => {
  updateBadge();
  const d = $("#cartDrawer");
  if (d && d.classList.contains("open")) { clearTimeout(drawerTimer); drawerTimer = setTimeout(renderCart, 120); }
});
window.addEventListener("storage", (e) => { if (e.key === "mocciCart") window.dispatchEvent(new CustomEvent("cart:changed")); });

document.addEventListener("DOMContentLoaded", () => {
  renderHeader();
  buildDrawer();
  hydrateIcons();
  if (location.search.includes("cart=1")) openCart();
  // Si la página arranca con productos en el carrito, se reconcilian con el servidor (stock/precios).
  if (Cart.count()) Cart.quote({ silent: true }).then(updateBadge);
});
