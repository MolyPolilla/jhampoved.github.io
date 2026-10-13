/* MocciMoth — páginas de cuenta: entrar, registro, perfil y configuración inicial del admin.
   Una sola página activa por vez, según <body data-page="...">. */
"use strict";

const page = document.body.dataset.page;
const form = $("#f"), msg = $("#msg");
const say = (t, type = "") => { msg.className = "msg " + type; msg.textContent = t; };
const fieldErr = (name, t) => { const f = $(`[data-f="${name}"]`); if (f) { f.classList.toggle("has-error", !!t); $("em", f).textContent = t || ""; } };
const clearErrs = () => $$("[data-f]").forEach((f) => f.classList.remove("has-error"));
const ESTADOS = { pago_simulado: "Pago simulado", preparando: "Preparando", enviado: "Enviado", entregado: "Entregado", cancelado: "Cancelado" };

/* ------------------------------ Mi cuenta ------------------------------- */
async function renderAccount() {
  const s = await api("GET", "/api/setup-status");
  $("#setup").classList.toggle("hidden", !s.data.needsSetup);
  const r = await api("GET", "/api/me");
  const u = r.data.user;
  if (!u) { if (r.data.pending) showPending(r.data.pending); return; }
  form.classList.add("hidden");
  $("#me").innerHTML = `<div class="notice"><i data-icon="user"></i><div><b>${esc(u.nombre)}</b><br>${esc(u.email)}<br><span class="pill ${u.role === "admin" ? "pink" : ""}">Rol: ${esc(u.role)}</span></div></div>
    <div class="actions" style="margin-top:16px">
      <a class="btn soft" href="/perfil.html"><i data-icon="pencil"></i>Editar perfil</a>
      ${u.role === "admin" ? '<a class="btn" href="/admin.html"><i data-icon="layout-dashboard"></i>Panel admin</a>' : ""}
      <button class="btn dark" id="out" type="button"><i data-icon="log-out"></i>Salir</button>
    </div>`;
  hydrateIcons($("#me"));
  $("#out").addEventListener("click", async () => { await api("POST", "/api/logout"); location.reload(); });
  loadOrders();
}
async function loadOrders() {
  const r = await api("GET", "/api/orders");
  if (!r.ok) return;
  $("#ordersBox").classList.remove("hidden");
  $("#orders").innerHTML = r.data.length
    ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Pedido</th><th>Total</th><th>Estado</th><th></th></tr></thead><tbody>${r.data.map((o) =>
      `<tr><td><b>${esc(o.numero_pedido || "#" + o.id)}</b><br><span class="muted">${esc(o.created_at)}</span></td><td>${money(o.total)}<br><span class="muted">${o.unidades} u.</span></td>
       <td><span class="pill pink">${esc(ESTADOS[o.estado] || o.estado)}</span></td><td><a class="btn sm soft" href="/checkout.html?pedido=${o.id}">${ic("receipt", "i-sm")}Comprobante</a></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="notice">${ic("info")}Todavía no hiciste pedidos.</div>`;
}

/* ------------------------------ Envíos de formularios ------------------- */
async function submit(e, fn) {
  e.preventDefault();
  clearErrs();
  say("");
  const btn = $("button[type=submit]", form);
  setLoading(btn, true, "Enviando…");
  try { await fn(Object.fromEntries(new FormData(form))); } finally { setLoading(btn, false); }
}

/* ------------------------- Verificación en dos pasos (admin) ------------------------- */
function showPending(kind) {
  form.classList.add("hidden");
  if (kind === "mfa") { $("#mfaForm").classList.remove("hidden"); $("#mfaForm input").focus(); return; }
  $("#enroll").classList.remove("hidden");
  startEnroll();
}
async function startEnroll() {
  const r = await api("POST", "/api/admin/mfa/setup", {});
  if (!r.ok) return say(r.data.error || "No se pudo generar la clave.", "err");
  $("#enrollSecret").textContent = r.data.secret.replace(/(.{4})/g, "$1 ").trim();
}
async function cancelPending() { await api("POST", "/api/logout"); location.reload(); }

if (page === "cuenta") {
  $("#mfaCancel").addEventListener("click", cancelPending);
  $("#enrollCancel").addEventListener("click", cancelPending);
  $("#recoveryDone").addEventListener("click", () => location.reload());
  $("#mfaForm").addEventListener("submit", async (e) => {
    e.preventDefault(); clearErrs(); say("");
    const code = e.target.elements.code.value.trim();
    if (!code) return fieldErr("code", "Ingresá el código.");
    const btn = $("button[type=submit]", e.target);
    setLoading(btn, true, "Verificando…");
    try {
      const r = await api("POST", "/api/login/mfa", { code });
      if (r.ok) { e.target.reset(); e.target.classList.add("hidden"); say("¡Listo!", "ok"); renderAccount(); }
      else say(r.data.error || "Código incorrecto.", "err");
    } finally { setLoading(btn, false); }
  });
  $("#enrollForm").addEventListener("submit", async (e) => {
    e.preventDefault(); clearErrs(); say("");
    const code = e.target.elements.code.value.trim();
    if (!code) return fieldErr("code", "Ingresá el código de la app.");
    const btn = $("button[type=submit]", e.target);
    setLoading(btn, true, "Activando…");
    try {
      const r = await api("POST", "/api/admin/mfa/enable", { code });
      if (r.ok) {
        e.target.classList.add("hidden");
        $("#recoveryList").innerHTML = r.data.recoveryCodes.map((c) => `<li><code>${esc(c)}</code></li>`).join("");
        $("#recoveryBox").classList.remove("hidden");
        say("Verificación en dos pasos activada.", "ok");
      } else say(r.data.error || "No se pudo activar.", "err");
    } finally { setLoading(btn, false); }
  });
  renderAccount();
  form.addEventListener("submit", (e) => submit(e, async (b) => {
    if (!b.email) return fieldErr("email", "Ingresá tu email.");
    if (!b.password) return fieldErr("password", "Ingresá tu contraseña.");
    const r = await api("POST", "/api/login", b);
    if (r.ok) { say("¡Listo!", "ok"); renderAccount(); } else say(r.data.error || "No se pudo entrar.", "err");
  }));
}

if (page === "registro") {
  form.addEventListener("submit", (e) => submit(e, async (b) => {
    let bad = false;
    if (b.nombre.trim().length < 2) { fieldErr("nombre", "Ingresá tu nombre."); bad = true; }
    if (!/^\S+@\S+\.\S{2,}$/.test(b.email)) { fieldErr("email", "Email no válido."); bad = true; }
    if (b.password.length < 8) { fieldErr("password", "Mínimo 8 caracteres."); bad = true; }
    if (bad) return;
    const r = await api("POST", "/api/register", b);
    if (r.ok) { form.reset(); say("Cuenta creada. Ya podés entrar desde Mi cuenta.", "ok"); } else say(r.data.error || "No se pudo crear.", "err");
  }));
}

if (page === "perfil") {
  (async () => {
    const r = await api("GET", "/api/me");
    if (!r.data.user) return say("Iniciá sesión para editar tu perfil.", "err");
    form.classList.remove("hidden");
    ["nombre", "telefono", "direccion", "fecha_nacimiento"].forEach((k) => (form.elements[k].value = r.data.user[k] || ""));
  })();
  form.addEventListener("submit", (e) => submit(e, async (b) => {
    if (b.nombre.trim().length < 2) return fieldErr("nombre", "Ingresá tu nombre.");
    const r = await api("PUT", "/api/profile", b);
    if (r.ok) { say("Guardado.", "ok"); toast("Perfil actualizado."); } else say(r.data.error || "Error al guardar.", "err");
  }));
}

if (page === "setup") {
  (async () => {
    const s = await api("GET", "/api/setup-status");
    $("#setupTokenField").classList.toggle("hidden", !s.data.setupTokenRequired);
    if (!s.data.needsSetup) { form.classList.add("hidden"); say("El administrador ya está configurado.", "ok"); }
  })();
  form.addEventListener("submit", (e) => submit(e, async (b) => {
    let bad = false;
    if (b.nombre.trim().length < 2) { fieldErr("nombre", "Ingresá un nombre."); bad = true; }
    if (!/^\S+@\S+\.\S{2,}$/.test(b.email)) { fieldErr("email", "Email no válido."); bad = true; }
    if (b.password.length < 8) { fieldErr("password", "Mínimo 8 caracteres."); bad = true; }
    if (bad) return;
    const r = await api("POST", "/api/setup-admin", b);
    if (r.ok) { form.classList.add("hidden"); say("Administrador creado. Volvé a Mi cuenta para entrar.", "ok"); } else say(r.data.error || "No se pudo crear.", "err");
  }));
}
