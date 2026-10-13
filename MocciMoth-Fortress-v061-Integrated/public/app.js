/* MocciMoth — catálogo: búsqueda, categorías, favoritos y "agregar al carrito".
   Depende de common.js (Cart, api, ic, esc, money, toast). */
"use strict";

let products = [];
const state = { q: "", cat: "Todas", onlyFavs: false };
const FKEY = "mocciFavs";
const loadFavs = () => { try { return new Set(JSON.parse(localStorage.getItem(FKEY) || "[]")); } catch { return new Set(); } };
const favs = loadFavs();
const saveFavs = () => { try { localStorage.setItem(FKEY, JSON.stringify([...favs])); } catch { /* ignore */ } };

const grid = $("#products");

async function load() {
  grid.innerHTML = `<p class="empty light">${ic("loader", "spin")} Cargando peluches…</p>`;
  const r = await api("GET", "/api/products");
  if (!r.ok) {
    grid.innerHTML = `<p class="empty light">${esc(r.data.error || "No se pudieron cargar los productos.")}</p>`;
    return;
  }
  products = r.data;
  renderChips();
  render();
}

function renderChips() {
  const cats = ["Todas", ...new Set(products.map((p) => p.categoria))];
  $("#chips").innerHTML =
    cats.map((c) => `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="${state.cat === c}">${ic(c === "Todas" ? "layout-grid" : "tag", "i-sm")}${esc(c)}</button>`).join("") +
    `<button class="chip" type="button" data-favs aria-pressed="${state.onlyFavs}">${ic("heart", "i-sm")}Favoritos</button>`;
}

function stockBadge(p) {
  if (p.stock <= 0) return `<span class="stock out">${ic("circle-alert", "i-sm")} Agotado</span>`;
  if (p.stock <= 5) return `<span class="stock low">${ic("info", "i-sm")} ¡Quedan ${p.stock}!</span>`;
  return `<span class="stock">${ic("circle-check", "i-sm")} En stock (${p.stock})</span>`;
}

function render() {
  const t = state.q.trim().toLowerCase();
  const list = products.filter((p) =>
    (state.cat === "Todas" || p.categoria === state.cat) &&
    (!state.onlyFavs || favs.has(p.id)) &&
    (!t || (p.nombre + " " + p.descripcion).toLowerCase().includes(t)));

  if (!list.length) {
    grid.innerHTML = `<div class="empty light"><img class="gif big" src="/assets/gifs/gatito.gif" alt=""><p>No encontramos peluches con ese filtro.</p></div>`;
    return;
  }
  grid.innerHTML = list.map((p) => {
    const out = p.stock <= 0, max = Math.min(p.stock, 99);
    return `<article class="card" data-id="${p.id}">
      <span class="tape"></span>
      <div class="pic">
        ${p.imagen ? `<img src="${esc(p.imagen)}" alt="${esc(p.nombre)}" loading="lazy">` : `<span class="noimg">${ic("package")}</span>`}
        <span class="cat-chip">${ic("tag", "i-sm")}${esc(p.categoria)}</span>
        <button class="icon-btn sm fav ${favs.has(p.id) ? "on" : ""}" type="button" data-fav aria-pressed="${favs.has(p.id)}" aria-label="${favs.has(p.id) ? "Quitar de favoritos" : "Guardar en favoritos"}: ${esc(p.nombre)}">${ic("heart", "i-sm")}</button>
      </div>
      <div class="body">
        <h3>${esc(p.nombre)}</h3>
        <p class="desc">${esc(p.descripcion)}</p>
        ${stockBadge(p)}
        <div class="row">
          <span class="price">${money(p.precio)}</span>
          <div class="stepper" role="group" aria-label="Cantidad">
            <button type="button" data-step="-1" aria-label="Menos" ${out ? "disabled" : ""}>${ic("minus", "i-sm")}</button>
            <input type="number" min="1" max="${max}" value="1" data-qty aria-label="Cantidad de ${esc(p.nombre)}" ${out ? "disabled" : ""}>
            <button type="button" data-step="1" aria-label="Más" ${out ? "disabled" : ""}>${ic("plus", "i-sm")}</button>
          </div>
        </div>
        <button class="btn block" type="button" data-add style="margin-top:14px" ${out ? "disabled" : ""}>${ic("shopping-cart")}${out ? "Agotado" : "Agregar al carrito"}</button>
      </div>
    </article>`;
  }).join("");
}

grid.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = +card.dataset.id, p = products.find((x) => x.id === id);
  if (!p) return;
  const inp = $("[data-qty]", card);

  if (e.target.closest("[data-step]")) {
    const v = (+inp.value || 1) + +e.target.closest("[data-step]").dataset.step;
    inp.value = Math.min(Math.max(1, v), Math.min(p.stock, 99));
  } else if (e.target.closest("[data-fav]")) {
    favs.has(id) ? favs.delete(id) : favs.add(id);
    saveFavs();
    const on = favs.has(id), b = e.target.closest("[data-fav]");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
    if (state.onlyFavs) render();
  } else if (e.target.closest("[data-add]")) {
    const want = Math.max(1, Math.floor(+inp.value || 1));
    const have = Cart.read()[id] || 0;
    const room = p.stock - have;
    if (room <= 0) return toast(`Ya tenés todo el stock de ${p.nombre} en el carrito.`, "info");
    const n = Math.min(want, room);
    Cart.add(id, n);
    toast(n < want ? `Agregamos ${n}: es todo el stock disponible.` : `${p.nombre} × ${n} agregado al carrito.`, n < want ? "info" : "ok");
    inp.value = 1;
    Cart.quote({ silent: true }); // el servidor confirma stock y descuento
  }
});

$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-cat]");
  if (c) state.cat = c.dataset.cat;
  else if (e.target.closest("[data-favs]")) state.onlyFavs = !state.onlyFavs;
  else return;
  renderChips();
  render();
});

load();
