/* MocciMoth — checkout SIMULADO en 5 pasos.
   1 Resumen · 2 Envío · 3 Pago (método + tarjeta demo) · 4 Confirmar · 5 Comprobante.
   Reglas de seguridad:
   - El total que se muestra viene del servidor (/api/cart/quote); el servidor lo recalcula otra vez al cobrar.
   - El número de tarjeta y el CVV viven solo en memoria de esta página: no se guardan en localStorage,
     ni en cookies, ni en la base de datos. El servidor solo conserva los últimos 4 dígitos y la marca.
   - Solo se aceptan números de PRUEBA conocidos; una tarjeta real se rechaza antes de enviarse. */
"use strict";

const DEMO_CARDS = { "4242424242424242": "Visa", "4111111111111111": "Visa", "4000056655665556": "Visa", "5555555555554444": "Mastercard", "5105105105105100": "Mastercard", "378282246310005": "Amex" };
const STEPS = [["Resumen", "shopping-cart"], ["Envío", "truck"], ["Pago", "credit-card"], ["Confirmar", "shield-check"], ["Comprobante", "receipt"]];
const METODOS = {
  tarjeta: { t: "Tarjeta demo", d: "Visa, Mastercard o Amex de prueba", i: "credit-card" },
  transferencia: { t: "Transferencia demo", d: "Alias ficticio, sin dinero real", i: "landmark" },
  billetera: { t: "Billetera demo", d: "MocciPay de práctica", i: "wallet" },
};
const ESTADOS = { pago_simulado: "Pago simulado aprobado", preparando: "Preparando", enviado: "Enviado", entregado: "Entregado", cancelado: "Cancelado" };

const S = {
  step: 1, user: null, quote: null, busy: false, ack: false, order: null,
  envio: { nombre: "", telefono: "", direccion: "", ciudad: "", provincia: "", cp: "" },
  pago: { metodo: "tarjeta", numero: "", titular: "", vencimiento: "", cvv: "" },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stage = $("#stage"), side = $("#side");

/* ------------------------------ Utilidades de formulario ---------------- */
const luhn = (n) => { let s = 0, d = false; for (let i = n.length - 1; i >= 0; i--) { let x = +n[i]; if (d) { x *= 2; if (x > 9) x -= 9; } s += x; d = !d; } return s % 10 === 0; };
const digits = (v) => String(v).replace(/\D/g, "");
const fmtCard = (v) => { const d = digits(v).slice(0, 19); return /^3[47]/.test(d) ? [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter(Boolean).join(" ") : d.replace(/(.{4})/g, "$1 ").trim(); };
const fmtExp = (v) => { const d = digits(v).slice(0, 4); return d.length > 2 ? d.slice(0, 2) + "/" + d.slice(2) : d; };
const brandOf = (n) => DEMO_CARDS[n] || (/^4/.test(n) ? "Visa" : /^(5[1-5]|2)/.test(n) ? "Mastercard" : /^3[47]/.test(n) ? "Amex" : "");
const fmtDate = (s) => { const d = new Date(String(s).replace(" ", "T") + "Z"); return isNaN(d) ? s : d.toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short" }); };

function field(name, label, { type = "text", ph = "", value = "", hint = "", attrs = "", icon = "" } = {}) {
  return `<label class="field" data-f="${name}"><span class="lbl">${icon ? ic(icon, "i-sm") : ""}${label}</span>
    <input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" ${attrs}>
    ${hint ? `<span class="hint">${hint}</span>` : ""}<span class="ferr">${ic("circle-alert", "i-sm")}<em></em></span></label>`;
}
function setErr(name, msg) {
  const f = $(`[data-f="${name}"]`);
  if (!f) return;
  f.classList.toggle("has-error", !!msg);
  f.classList.toggle("valid", !msg && !!$("input", f)?.value);
  const em = $("em", f);
  if (em) em.textContent = msg || "";
  const inp = $("input,select", f);
  if (inp) inp.setAttribute("aria-invalid", msg ? "true" : "false");
}
function showErrors(errs) {
  Object.entries(errs).forEach(([k, v]) => setErr(k, v));
  const first = Object.keys(errs)[0];
  if (first) $(`[data-f="${first}"] input`)?.focus();
}

/* ------------------------------ Validaciones (espejo del servidor) ------ */
function checkEnvio() {
  const e = S.envio, errs = {};
  if (e.nombre.trim().length < 2) errs["envio.nombre"] = "Ingresá un nombre (mínimo 2 letras).";
  if (e.telefono && !/^[0-9 +()-]{6,20}$/.test(e.telefono.trim())) errs["envio.telefono"] = "Teléfono no válido.";
  if (e.direccion.trim().length < 5) errs["envio.direccion"] = "Ingresá una dirección ficticia (mínimo 5 caracteres).";
  if (e.ciudad.trim().length < 2) errs["envio.ciudad"] = "Ingresá la ciudad.";
  if (e.provincia.trim().length < 2) errs["envio.provincia"] = "Ingresá la provincia.";
  if (!/^[A-Za-z0-9 -]{3,10}$/.test(e.cp.trim())) errs["envio.cp"] = "Código postal no válido.";
  return errs;
}
function checkPago() {
  const p = S.pago, errs = {};
  if (p.metodo !== "tarjeta") return errs;
  const n = digits(p.numero);
  if (n.length < 13 || !luhn(n)) errs["pago.numero"] = "Número de tarjeta no válido.";
  else if (!DEMO_CARDS[n]) errs["pago.numero"] = "Solo se aceptan tarjetas de PRUEBA (ej. 4242 4242 4242 4242). No uses una tarjeta real.";
  if (p.titular.trim().length < 2 || !/^[\p{L} .'-]+$/u.test(p.titular.trim())) errs["pago.titular"] = "Ingresá el nombre del titular demo.";
  const m = /^(\d{2})\/(\d{2})$/.exec(p.vencimiento);
  if (!m || +m[1] < 1 || +m[1] > 12) errs["pago.vencimiento"] = "Usá el formato MM/AA.";
  else { const now = new Date(), y = 2000 + +m[2]; if (y < now.getFullYear() || (y === now.getFullYear() && +m[1] < now.getMonth() + 1)) errs["pago.vencimiento"] = "La tarjeta demo está vencida."; }
  if (!/^\d{3,4}$/.test(p.cvv)) errs["pago.cvv"] = "El CVV demo tiene 3 o 4 dígitos.";
  return errs;
}

/* ------------------------------ Render ---------------------------------- */
function renderSteps() {
  $("#steps").innerHTML = STEPS.map(([t, icon], i) => {
    const n = i + 1, cls = n === S.step ? "cur" : n < S.step ? "done" : "";
    return `<li class="${cls}" ${n === S.step ? 'aria-current="step"' : ""}><span class="n">${n < S.step ? ic("check", "i-sm") : n}</span><span class="t">${t}</span></li>`;
  }).join("");
}

function renderSide() {
  const q = S.quote;
  if (S.step === 5 || !q || !q.lineas.length) { side.classList.add("hidden"); return; }
  side.classList.remove("hidden");
  side.innerHTML = `<h2>${ic("receipt")} Resumen de compra</h2>
    ${q.lineas.map((l) => `<div class="sum-line">${l.imagen ? `<img src="${esc(l.imagen)}" alt="">` : `<span class="noimg">${ic("package")}</span>`}
      <div><b>${esc(l.nombre)}</b><small>${l.cantidad} × ${money(l.precio)}</small></div><b>${money(l.subtotal)}</b></div>`).join("")}
    <dl class="totals" style="margin-top:12px">
      <div><dt>Subtotal (${q.unidades} peluches)</dt><dd>${money(q.subtotal)}</dd></div>
      <div class="disc ${q.descuento ? "" : "off"}"><dt>${ic("percent", "i-sm")} Descuento ${q.descuento_pct}%</dt><dd>−${money(q.descuento)}</dd></div>
      <div class="grand"><dt>Total</dt><dd>${money(q.total)}</dd></div>
    </dl>
    ${q.proximo ? `<p class="hint">${ic("tag", "i-sm")} Sumá ${q.proximo.faltan} más y obtené ${q.proximo.pct}% OFF.</p>` : ""}
    <div class="demo-flag">${ic("lock", "i-sm")} Pago ficticio · no se cobra dinero real</div>`;
}

function stepResumen() {
  const q = S.quote;
  if (!q || !q.lineas.length) {
    return `<div class="empty"><img class="gif big" src="/assets/gifs/gatito.gif" alt=""><h2 style="justify-content:center">Tu carrito está vacío</h2><p class="muted">Agregá peluches para continuar.</p><a class="btn" href="/#peluches">${ic("store")}Ver peluches</a></div>`;
  }
  return `<h2>${ic("shopping-cart", "i-lg")} Revisá tu compra</h2><p class="sub">Podés cambiar cantidades; el total se recalcula en el servidor.</p>
    ${q.lineas.map((l) => `<div class="cart-line" data-id="${l.id}">
      ${l.imagen ? `<img src="${esc(l.imagen)}" alt="${esc(l.nombre)}">` : `<div class="noimg">${ic("package")}</div>`}
      <div class="cl-info"><b class="cl-name">${esc(l.nombre)}</b><span class="muted">${money(l.precio)} c/u</span>
        <div class="stepper"><button type="button" data-act="dec" aria-label="Disminuir">${ic("minus", "i-sm")}</button><span aria-live="polite">${l.cantidad}</span><button type="button" data-act="inc" aria-label="Aumentar" ${l.cantidad >= l.stock ? "disabled" : ""}>${ic("plus", "i-sm")}</button></div>
        ${l.cantidad >= l.stock ? `<span class="stock-note">${ic("info", "i-sm")} Máximo disponible (${l.stock})</span>` : ""}</div>
      <div class="cl-side"><b>${money(l.subtotal)}</b><button class="icon-btn sm" type="button" data-act="del" aria-label="Quitar ${esc(l.nombre)}">${ic("trash-2", "i-sm")}</button></div></div>`).join("")}
    ${S.user ? "" : `<div class="notice err" style="margin-top:16px">${ic("user")}<div><b>Necesitás iniciar sesión</b> para comprar. Tu carrito se conserva. <a href="/cuenta.html"><u>Entrar</u></a> o <a href="/registro.html"><u>crear cuenta</u></a>.</div></div>`}
    <div class="step-actions"><button class="btn dark" type="button" data-act="clear">${ic("trash-2")}Vaciar carrito</button>
      <button class="btn" type="button" data-next ${S.user ? "" : "disabled"}>Continuar al envío${ic("arrow-right")}</button></div>`;
}

function stepEnvio() {
  const e = S.envio;
  return `<h2>${ic("truck", "i-lg")} Dirección de envío ficticia</h2><p class="sub">Usá datos inventados: es solo una práctica.</p>
    <form class="form" id="form" novalidate autocomplete="off">
      <div class="form-2">${field("envio.nombre", "Nombre y apellido", { value: e.nombre, ph: "Ana Prueba", icon: "user" })}${field("envio.telefono", "Teléfono (opcional)", { value: e.telefono, ph: "11 5555 0000", type: "tel" })}</div>
      ${field("envio.direccion", "Dirección", { value: e.direccion, ph: "Calle Falsa 123, piso 4", icon: "map-pin" })}
      <div class="form-2">${field("envio.ciudad", "Ciudad", { value: e.ciudad, ph: "Ciudad ficticia" })}${field("envio.provincia", "Provincia", { value: e.provincia, ph: "Provincia" })}</div>
      ${field("envio.cp", "Código postal", { value: e.cp, ph: "1000" })}
      <div class="step-actions"><button class="btn soft" type="button" data-back>${ic("arrow-left")}Volver</button><button class="btn" type="submit">Continuar al pago${ic("arrow-right")}</button></div>
    </form>`;
}

function cardPreview() {
  const p = S.pago, n = digits(p.numero);
  const shown = (fmtCard(n) || "•••• •••• •••• ••••");
  return `<div class="ccard" aria-hidden="true"><span class="brand-tag" id="ccBrand">${esc(brandOf(n))}</span><div class="chip-ic"></div>
    <div class="num" id="ccNum">${esc(shown)}</div>
    <div class="meta"><span id="ccName">${esc(p.titular || "TITULAR DEMO")}</span><span id="ccExp">${esc(p.vencimiento || "MM/AA")}</span></div><span class="demo">SOLO DEMO</span></div>`;
}

function stepPago() {
  const p = S.pago;
  const opts = Object.entries(METODOS).map(([k, m]) => `<label class="pay-opt"><input type="radio" name="metodo" value="${k}" ${p.metodo === k ? "checked" : ""}>
    <span class="ico">${ic(m.i)}</span><span><b>${m.t}</b><small>${m.d}</small></span><span class="tick">${ic("check", "i-sm")}</span></label>`).join("");
  let extra = "";
  if (p.metodo === "tarjeta") {
    extra = `${cardPreview()}
      <div class="form">
        <div class="notice">${ic("info")}<div>Usá una <b>tarjeta de prueba</b>. <button class="link-btn" type="button" data-fill>Rellenar con la tarjeta demo</button>
          <details style="margin-top:6px"><summary class="link-btn">Ver tarjetas de prueba</summary><div class="hint" style="margin-top:6px">4242 4242 4242 4242 (Visa)<br>5555 5555 5555 4444 (Mastercard)<br>3782 822463 10005 (Amex)<br>Vencimiento futuro (ej. 12/30) y CVV de 3 o 4 dígitos inventados.</div></details></div></div>
        ${field("pago.titular", "Titular (ficticio)", { value: p.titular, ph: "TITULAR DEMO", attrs: 'autocomplete="off" maxlength="60"', icon: "user" })}
        ${field("pago.numero", "Número de tarjeta de prueba", { value: fmtCard(p.numero), ph: "4242 4242 4242 4242", attrs: 'inputmode="numeric" autocomplete="off" maxlength="23"', icon: "credit-card" })}
        <div class="form-2">${field("pago.vencimiento", "Vencimiento", { value: p.vencimiento, ph: "MM/AA", attrs: 'inputmode="numeric" autocomplete="off" maxlength="5"' })}
        ${field("pago.cvv", "CVV demo", { value: p.cvv, ph: "123", type: "password", attrs: 'inputmode="numeric" autocomplete="off" maxlength="4"', icon: "lock" })}</div>
      </div>`;
  } else if (p.metodo === "transferencia") {
    extra = `<div class="notice">${ic("landmark")}<div><b>Transferencia demo.</b> Alias ficticio: <code>moccimoth.demo.lab</code>. No se transfiere dinero: al confirmar se genera un pedido de práctica.</div></div>`;
  } else {
    extra = `<div class="notice">${ic("wallet")}<div><b>Billetera MocciPay (demo).</b> Es una billetera inventada para el laboratorio; no hay cuentas ni saldos reales.</div></div>`;
  }
  return `<h2>${ic("credit-card", "i-lg")} Método de pago</h2><p class="sub">Todo es una simulación. No se procesa ningún pago real.</p>
    <form id="form" novalidate autocomplete="off"><div class="pay-opts">${opts}</div>${extra}
      <div class="step-actions"><button class="btn soft" type="button" data-back>${ic("arrow-left")}Volver</button><button class="btn" type="submit">Revisar pedido${ic("arrow-right")}</button></div></form>`;
}

function stepConfirmar() {
  const e = S.envio, p = S.pago, q = S.quote, n = digits(p.numero);
  const payTxt = p.metodo === "tarjeta" ? `${brandOf(n) || "Tarjeta"} demo •••• ${n.slice(-4)}` : METODOS[p.metodo].t;
  return `<div class="review"><h2>${ic("shield-check", "i-lg")} Confirmá tu pedido</h2><p class="sub">Revisá los datos antes de “pagar”. No se cobrará nada.</p>
    <div class="blk"><h3>${ic("truck")} Envío <button class="link-btn" type="button" data-goto="2">Editar</button></h3><dl><dt>Nombre</dt><dd>${esc(e.nombre)}</dd><dt>Dirección</dt><dd>${esc(e.direccion)}, ${esc(e.ciudad)}, ${esc(e.provincia)} (${esc(e.cp)})</dd>${e.telefono ? `<dt>Teléfono</dt><dd>${esc(e.telefono)}</dd>` : ""}</dl></div>
    <div class="blk"><h3>${ic(METODOS[p.metodo].i)} Pago <button class="link-btn" type="button" data-goto="3">Editar</button></h3><dl><dt>Método</dt><dd>${esc(payTxt)}</dd><dt>Estado</dt><dd><span class="pill pink">${ic("sparkles", "i-sm")} Pago ficticio</span></dd></dl></div>
    <div class="blk"><h3>${ic("package")} Productos <button class="link-btn" type="button" data-goto="1">Editar</button></h3><dl>${q.lineas.map((l) => `<dt>${l.cantidad} ×</dt><dd>${esc(l.nombre)} — ${money(l.subtotal)}</dd>`).join("")}</dl></div>
    <div class="blk" style="border:0"><dl><dt>Total a “pagar”</dt><dd style="font:600 1.4rem Fredoka">${money(q.total)}${q.descuento ? ` <span class="pill green">${q.descuento_pct}% OFF</span>` : ""}</dd></dl></div>
    <label class="field ${S.ackErr ? "has-error" : ""}" data-f="ack" style="grid-template-columns:auto 1fr;align-items:start;gap:10px"><input type="checkbox" id="ack" ${S.ack ? "checked" : ""} style="width:22px;height:22px;margin-top:2px">
      <span>Entiendo que es una <b>simulación educativa</b> y que no estoy usando datos reales.<span class="ferr" style="display:${S.ackErr ? "flex" : "none"}">${ic("circle-alert", "i-sm")}<em>Tenés que aceptar para continuar.</em></span></span></label>
    <div class="step-actions"><button class="btn soft" type="button" data-back>${ic("arrow-left")}Volver</button><button class="btn" type="button" id="pay">${ic("lock")}Confirmar pago simulado</button></div></div>`;
}

function stepComprobante() {
  const o = S.order;
  const metodo = o.metodo_pago === "tarjeta" ? `${esc(o.marca || "Tarjeta")} demo •••• ${esc(o.ultimos4)}` : esc(METODOS[o.metodo_pago]?.t || o.metodo_pago);
  return `<div class="success"><img class="gif" src="/assets/gifs/corazon.gif" alt=""><h2>${ic("circle-check", "i-lg")} ¡Gracias por tu compra!</h2><p class="muted">Pedido registrado. Este es un comprobante de práctica.</p></div>
    <div class="receipt" id="receipt"><div class="stamp">COMPROBANTE<br>SIMULADO</div>
      <h3>${ic("receipt")} MocciMoth</h3><div class="muted">Sin valor fiscal ni de pago</div>
      <div class="oid">Pedido ${esc(o.numero_pedido)}</div>
      <div class="r"><span>Fecha</span><span>${esc(fmtDate(o.created_at))}</span></div>
      <div class="r"><span>Estado</span><b>${esc(ESTADOS[o.estado] || o.estado)}</b></div>
      <div class="r"><span>Pago</span><span>${metodo}</span></div>
      <div class="r"><span>Envío a</span><span style="text-align:right">${esc(o.envio.nombre)}<br>${esc(o.envio.direccion)}, ${esc(o.envio.ciudad)} (${esc(o.envio.cp)})</span></div>
      <hr>${o.items.map((i) => `<div class="r"><span>${i.cantidad} × ${esc(i.nombre)}</span><span>${money(i.subtotal)}</span></div>`).join("")}<hr>
      <div class="r"><span>Subtotal (${o.unidades} u.)</span><span>${money(o.subtotal)}</span></div>
      <div class="r dsc"><span>Descuento ${o.descuento_pct}%</span><span>−${money(o.descuento)}</span></div>
      <div class="r big"><span>Total</span><span>${money(o.total)}</span></div></div>
    <div class="step-actions no-print"><button class="btn soft" type="button" data-print>${ic("printer")}Imprimir comprobante</button><a class="btn" href="/">${ic("store")}Volver a la tienda</a></div>`;
}

function renderStage() {
  let html = "";
  if (S.step === 1) html = stepResumen();
  else if (S.step === 2) html = stepEnvio();
  else if (S.step === 3) html = stepPago();
  else if (S.step === 4) html = stepConfirmar();
  else html = stepComprobante();
  stage.innerHTML = html + (S.busy ? `<div class="processing"><img class="gif big" src="/assets/gifs/espiral.gif" alt=""><b>Procesando pago ficticio…</b><span class="muted">No cierres esta ventana</span></div>` : "");
}
function render() { $(".co-grid").classList.toggle("solo", S.step === 5); renderSteps(); renderSide(); renderStage(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function go(n) { S.step = n; render(); }

/* ------------------------------ Eventos --------------------------------- */
stage.addEventListener("click", (e) => {
  const t = e.target;
  const act = t.closest("[data-act]");
  if (act) {
    const line = act.closest("[data-id]"), id = line ? +line.dataset.id : 0, q = Cart.read()[id] || 0;
    if (act.dataset.act === "inc") Cart.set(id, q + 1);
    else if (act.dataset.act === "dec") Cart.set(id, q - 1);
    else if (act.dataset.act === "del") Cart.remove(id);
    else if (act.dataset.act === "clear" && confirm("¿Vaciar todo el carrito?")) Cart.clear();
    return;
  }
  if (t.closest("[data-next]")) return go(2);
  if (t.closest("[data-back]")) return go(S.step - 1);
  if (t.closest("[data-goto]")) return go(+t.closest("[data-goto]").dataset.goto);
  if (t.closest("[data-print]")) return window.print();
  if (t.closest("[data-fill]")) {
    Object.assign(S.pago, { numero: "4242424242424242", titular: S.pago.titular || "TITULAR DEMO", vencimiento: "12/30", cvv: "123" });
    renderStage();
    return toast("Tarjeta demo cargada.", "info");
  }
  if (t.closest("#pay")) return confirmOrder();
});

stage.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "ack") { S.ack = el.checked; S.ackErr = false; return renderStage(); }
  if (!el.name) return;
  if (el.name === "pago.numero") { el.value = fmtCard(el.value); }
  if (el.name === "pago.vencimiento") el.value = fmtExp(el.value);
  if (el.name === "pago.cvv") el.value = digits(el.value).slice(0, 4);
  const [grp, key] = el.name.split(".");
  if (key && S[grp]) S[grp][key] = el.name === "pago.numero" ? digits(el.value) : el.value;
  // vista previa de la tarjeta + validación en vivo del número (avisa antes de enviar nada)
  if (grp === "pago") {
    const n = digits(S.pago.numero);
    $("#ccNum") && ($("#ccNum").textContent = fmtCard(n) || "•••• •••• •••• ••••");
    $("#ccName") && ($("#ccName").textContent = S.pago.titular || "TITULAR DEMO");
    $("#ccExp") && ($("#ccExp").textContent = S.pago.vencimiento || "MM/AA");
    $("#ccBrand") && ($("#ccBrand").textContent = brandOf(n));
    if (el.name === "pago.numero" && n.length >= 13 && luhn(n) && !DEMO_CARDS[n]) setErr("pago.numero", checkPago()["pago.numero"]);
    else if (el.name === "pago.numero") setErr("pago.numero", "");
  }
  if ($(`[data-f="${el.name}"]`)?.classList.contains("has-error")) setErr(el.name, "");
});
stage.addEventListener("focusout", (e) => {   // validación al salir del campo
  const el = e.target;
  if (!el.name || !el.name.includes(".")) return;
  const errs = el.name.startsWith("envio.") ? checkEnvio() : checkPago();
  if (el.value || errs[el.name]) setErr(el.name, errs[el.name] || "");
});
stage.addEventListener("change", (e) => {
  if (e.target.name === "metodo") { S.pago.metodo = e.target.value; renderStage(); }
});
stage.addEventListener("submit", (e) => {
  e.preventDefault();
  if (S.step === 2) {
    const errs = checkEnvio();
    if (Object.keys(errs).length) return showErrors(errs);
    go(3);
  } else if (S.step === 3) {
    const errs = checkPago();
    if (Object.keys(errs).length) return showErrors(errs);
    S.ack = false; S.ackErr = false;
    go(4);
  }
});

/* ------------------------------ Confirmar ------------------------------- */
async function confirmOrder() {
  if (!S.ack) { S.ackErr = true; return renderStage(); }
  S.busy = true; renderStage();
  await sleep(1200); // pequeña espera para que se vea el estado de carga
  const body = {
    items: Cart.items(), totalEsperado: S.quote.total, envio: S.envio,
    pago: { metodo: S.pago.metodo, ...(S.pago.metodo === "tarjeta" ? { tarjeta: { numero: S.pago.numero, titular: S.pago.titular, vencimiento: S.pago.vencimiento, cvv: S.pago.cvv } } : {}) },
  };
  const r = await api("POST", "/api/checkout", body);
  S.busy = false;
  if (r.ok) {
    S.order = r.data.pedido;
    S.pago = { metodo: "tarjeta", numero: "", titular: "", vencimiento: "", cvv: "" }; // se borra la tarjeta demo de memoria
    Cart.clear();
    history.replaceState(null, "", "/checkout.html?pedido=" + S.order.id);
    return go(5);
  }
  if (r.status === 409 && r.data.quote) {   // cambió stock o precio
    S.quote = r.data.quote;
    r.data.quote.avisos.forEach((a) => toast(a.mensaje, "info"));
    toast(r.data.error, "err");
    await Cart.quote({ silent: true });
    return go(1);
  }
  if (r.status === 400 && r.data.errores) {
    const keys = Object.keys(r.data.errores);
    const target = keys.some((k) => k.startsWith("envio.")) ? 2 : 3;
    toast(r.data.error || "Revisá los campos marcados.", "err");
    go(target);
    return setTimeout(() => showErrors(r.data.errores), 60);
  }
  if (r.status === 401) { S.user = null; toast("Tu sesión venció. Iniciá sesión de nuevo.", "err"); return go(1); }
  toast(r.data.error || "No se pudo completar el pedido.", "err");
  renderStage();
}

/* ------------------------------ Inicio ---------------------------------- */
async function refreshQuote() {
  S.quote = await Cart.quote({ silent: true });
  if (S.step === 1 || S.step === 4) { renderSide(); renderStage(); } else renderSide();
  if (S.step >= 2 && S.step < 5 && !S.quote.lineas.length) go(1);
}
window.addEventListener("cart:changed", () => { if (S.step < 5) refreshQuote(); });

(async function init() {
  const id = new URLSearchParams(location.search).get("pedido");
  const me = await api("GET", "/api/me");
  S.user = me.data.user || null;
  if (id) {   // ver comprobante de un pedido existente
    if (!S.user) { stage.innerHTML = `<div class="notice err">${ic("user")}<div>Iniciá sesión para ver tu comprobante. <a href="/cuenta.html"><u>Entrar</u></a></div></div>`; side.classList.add("hidden"); renderSteps(); return; }
    const r = await api("GET", "/api/orders/" + encodeURIComponent(id));
    if (!r.ok) { stage.innerHTML = `<div class="notice err">${ic("circle-alert")}<div>${esc(r.data.error || "Pedido no encontrado.")}</div></div>`; side.classList.add("hidden"); S.step = 5; renderSteps(); return; }
    S.order = r.data; S.step = 5; return render();
  }
  if (S.user) Object.assign(S.envio, { nombre: S.user.nombre || "", telefono: S.user.telefono || "", direccion: S.user.direccion || "" });
  S.quote = await Cart.quote();
  render();
})();
