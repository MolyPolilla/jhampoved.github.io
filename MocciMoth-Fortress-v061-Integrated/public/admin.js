/* MocciMoth — panel de administración.
   La autorización real ocurre en el servidor (cada ruta exige rol admin);
   este archivo solo muestra u oculta la interfaz. Todo texto se escapa con esc(). */
"use strict";

let products = [];
const f = $("#f"), listEl = $("#list");

function setErr(form, name, msg) {
  const fld = $(`[data-f="${name}"]`, form);
  if (!fld) return;
  fld.classList.toggle("has-error", !!msg);
  $("em", fld).textContent = msg || "";
}
const clearErrs = (form) => $$("[data-f]", form).forEach((x) => x.classList.remove("has-error"));
function applyErrs(form, errs = {}) { Object.entries(errs).forEach(([k, v]) => setErr(form, k, v)); }

async function init() {
  const m = await api("GET", "/api/me");
  const u = m.data.user;
  const guard = $("#guard");
  if (!u || u.role !== "admin") {
    guard.className = "notice danger";
    guard.innerHTML = `${ic("lock")}<div><b>Acceso denegado.</b> ${u ? "Tu cuenta no es de administrador." : 'Iniciá sesión como administrador en <a href="/cuenta.html"><u>Mi cuenta</u></a>.'}</div>`;
    return;
  }
  guard.className = "notice ok";
  guard.innerHTML = `${ic("shield-check")}<div>Sesión de administrador: <b>${esc(u.email)}</b></div>`;
  $("#admin").classList.remove("hidden");
  loadProducts();
}

/* ------------------------------ Pestañas -------------------------------- */
$(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  $$(".tabs .chip").forEach((c) => c.setAttribute("aria-pressed", c === b));
  ["productos", "pedidos", "seguridad"].forEach((t) => $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
  if (b.dataset.tab === "pedidos") loadOrders();
});

/* ------------------------------ Productos ------------------------------- */
async function loadProducts() {
  const r = await api("GET", "/api/products");
  products = r.ok ? r.data : [];
  if (!products.length) { listEl.innerHTML = `<div class="notice">${ic("info")}No hay productos todavía.</div>`; return; }
  listEl.innerHTML = products.map((p) => `
    <div class="adminitem" data-id="${p.id}">
      ${p.imagen ? `<img src="${esc(p.imagen)}" alt="">` : `<span class="noimg">${ic("package")}</span>`}
      <div>
        <b>${esc(p.nombre)}</b> <span class="pill">${ic("tag", "i-sm")}${esc(p.categoria)}</span><br>
        <span class="muted">${money(p.precio)} · ${p.stock <= 0 ? "agotado" : "stock " + p.stock}</span>
        <div class="stockedit">
          <div class="stepper" role="group" aria-label="Stock de ${esc(p.nombre)}">
            <button type="button" data-st="-1" aria-label="Restar stock">${ic("minus", "i-sm")}</button>
            <input type="number" min="0" max="9999" value="${p.stock}" data-stock aria-label="Stock">
            <button type="button" data-st="1" aria-label="Sumar stock">${ic("plus", "i-sm")}</button>
          </div>
          <button class="btn sm soft" type="button" data-savestock>${ic("check", "i-sm")}Guardar stock</button>
        </div>
      </div>
      <div class="actions">
        <button class="btn soft sm" type="button" data-edit>${ic("pencil", "i-sm")}Editar</button>
        <button class="btn dark sm" type="button" data-del>${ic("trash-2", "i-sm")}Eliminar</button>
      </div>
    </div>`).join("");
}

listEl.addEventListener("click", async (e) => {
  const row = e.target.closest("[data-id]");
  if (!row) return;
  const id = +row.dataset.id, p = products.find((x) => x.id === id);
  if (!p) return;
  const inp = $("[data-stock]", row);

  if (e.target.closest("[data-st]")) {
    inp.value = Math.min(9999, Math.max(0, (+inp.value || 0) + +e.target.closest("[data-st]").dataset.st));
  } else if (e.target.closest("[data-savestock]")) {
    const btn = e.target.closest("[data-savestock]");
    setLoading(btn, true, "Guardando…");
    const r = await api("PATCH", `/api/products/${id}/stock`, { stock: +inp.value });
    setLoading(btn, false);
    if (r.ok) { toast(`Stock de ${p.nombre}: ${r.data.stock}`); loadProducts(); } else toast(r.data.error || "No se pudo guardar.", "err");
  } else if (e.target.closest("[data-edit]")) {
    ["id", "nombre", "descripcion", "precio", "stock", "categoria", "imagen"].forEach((k) => (f.elements[k].value = p[k] ?? ""));
    f.elements.imagen.value = p.imagen || "";
    $("#save").innerHTML = ic("check") + "Guardar cambios";
    $("#cancel").classList.remove("hidden");
    $("#formTitle").innerHTML = ic("pencil", "i-lg") + "Editando: " + esc(p.nombre);
    clearErrs(f);
    f.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (e.target.closest("[data-del]")) {
    if (!confirm(`¿Eliminar "${p.nombre}"? Los pedidos anteriores conservan su registro.`)) return;
    const r = await api("DELETE", "/api/products/" + id);
    if (r.ok) { toast("Producto eliminado.", "info"); loadProducts(); } else toast(r.data.error || "No se pudo eliminar.", "err");
  }
});

function resetForm() {
  f.reset();
  f.elements.id.value = "";
  $("#save").innerHTML = ic("check") + "Publicar";
  $("#cancel").classList.add("hidden");
  $("#formTitle").innerHTML = ic("plus", "i-lg") + "Nuevo producto";
  clearErrs(f);
}
$("#cancel").addEventListener("click", resetForm);

const readFile = (file) => new Promise((ok, no) => {
  if (!file) return ok("");
  if (file.size > 4e6) return no(new Error("La imagen supera los 4 MB."));
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => no(new Error("No se pudo leer el archivo."));
  r.readAsDataURL(file);
});

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrs(f);
  $("#msg").textContent = "";
  const btn = $("#save"), b = Object.fromEntries(new FormData(f)), id = b.id;
  delete b.id;
  try { b.imageData = await readFile($("#file").files[0]); } catch (err) { $("#msg").className = "msg err"; return ($("#msg").textContent = err.message); }
  if (!b.imageData) delete b.imageData;
  setLoading(btn, true, "Guardando…");
  const r = await api(id ? "PUT" : "POST", id ? "/api/products/" + id : "/api/products", b);
  setLoading(btn, false);
  if (r.ok) { toast(id ? "Producto actualizado." : "Producto publicado."); resetForm(); loadProducts(); return; }
  applyErrs(f, r.data.errores);
  $("#msg").className = "msg err";
  $("#msg").textContent = r.data.error || "No se pudo guardar.";
});

/* ------------------------------ Pedidos --------------------------------- */
async function loadOrders() {
  const box = $("#orders");
  box.innerHTML = `<p class="muted">${ic("loader", "spin")} Cargando…</p>`;
  const r = await api("GET", "/api/admin/orders");
  if (!r.ok) { box.innerHTML = `<div class="notice err">${esc(r.data.error || "Error")}</div>`; return; }
  if (!r.data.length) { box.innerHTML = `<div class="notice">${ic("info")}Todavía no hay pedidos.</div>`; return; }
  box.innerHTML = `<table class="tbl"><thead><tr><th>Pedido</th><th>Cliente</th><th>Unidades</th><th>Total</th><th>Estado</th><th></th></tr></thead><tbody>${
    r.data.map((o) => `<tr><td><b>${esc(o.numero_pedido || "#" + o.id)}</b><br><span class="muted">${esc(o.created_at)}</span></td>
      <td>${esc(o.nombre || "—")}<br><span class="muted">${esc(o.email || "")}</span></td><td>${o.unidades}</td><td>${money(o.total)}</td>
      <td><span class="pill pink">${esc(o.estado)}</span></td><td><a class="btn sm soft" href="/checkout.html?pedido=${o.id}">${ic("receipt", "i-sm")}Ver</a></td></tr>`).join("")}</tbody></table>`;
}

/* ------------------------------ Contraseña ------------------------------ */
const pf = $("#pf");
pf.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrs(pf);
  const pm = $("#pmsg");
  pm.textContent = "";
  const b = Object.fromEntries(new FormData(pf)), errs = {};
  if (!b.actual) errs.actual = "Ingresá tu contraseña actual.";
  if ((b.nueva || "").length < 10) errs.nueva = "Usá al menos 10 caracteres.";
  else if (!/[A-Za-z]/.test(b.nueva) || !/\d/.test(b.nueva)) errs.nueva = "Combiná letras y números.";
  if (b.nueva !== b.confirmar) errs.confirmar = "Las contraseñas no coinciden.";
  if (Object.keys(errs).length) return applyErrs(pf, errs);
  const btn = $("#psave");
  setLoading(btn, true, "Actualizando…");
  const r = await api("POST", "/api/admin/password", b);
  setLoading(btn, false);
  if (r.ok) {
    pf.reset();
    pm.className = "msg ok";
    pm.textContent = "Contraseña actualizada. Las demás sesiones se cerraron.";
    toast("Contraseña cambiada.");
  } else {
    applyErrs(pf, r.data.errores);
    pm.className = "msg err";
    pm.textContent = r.data.error || "No se pudo cambiar.";
  }
});

init();
