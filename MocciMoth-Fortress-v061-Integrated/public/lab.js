"use strict";
const labState={products:[],suppliers:[]};
const table=(heads,rows)=>`<table class="lab-table"><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")||`<tr><td colspan="${heads.length}">Sin registros</td></tr>`}</tbody></table>`;
async function labRefresh(){
 const [o,pr,s,r]=await Promise.all([api("GET","/api/lab/overview"),api("GET","/api/products"),api("GET","/api/lab/suppliers"),api("GET","/api/lab/receipts")]);
 if(![o,pr,s,r].every(x=>x.ok)){toast("No se pudieron cargar los datos del laboratorio.","err");return;}
 labState.products=pr.data;labState.suppliers=s.data;
 const a=o.data;
 const metrics=[["Unidades disponibles",a.units],["Productos",a.products],["Stock bajo (≤ 3)",a.low_stock],["Proveedores activos",a.suppliers],["Pedidos demo",a.orders],["Importe demo",money(a.revenue_demo)]];
 $("#lab-stats").innerHTML=metrics.map(([label,value])=>`<div class="lab-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join("");
 $("#lab-products").innerHTML=table(["Producto","Stock","Precio"],pr.data.map(p=>`<tr><td>${esc(p.nombre)}</td><td><span class="lab-pill ${p.stock<=3?'low':''}">${p.stock}</span></td><td>${money(p.precio)}</td></tr>`));
 $("#lab-suppliers").innerHTML=table(["Nombre","Contacto","Estado"],s.data.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.contact)}</td><td>${x.active?'Activo':'Inactivo'}</td></tr>`));
 $("#lab-receipts").innerHTML=table(["Fecha","Producto","Unid.","Referencia"],r.data.map(x=>`<tr><td>${esc(x.created_at)}</td><td>${esc(x.product_name)}</td><td>+${x.quantity}</td><td>${esc(x.reference)}</td></tr>`));
 $("#lab-top").innerHTML=table(["Producto","Unidades pedidas"],a.top.map(x=>`<tr><td>${esc(x.name)}</td><td>${x.units}</td></tr>`));
 const productSelect=$("#receipt-form [name=product_id]");const selected=productSelect.value;
 productSelect.innerHTML=pr.data.map(x=>`<option value="${x.id}">${esc(x.nombre)} (${x.stock})</option>`).join("");if(pr.data.some(x=>String(x.id)===selected))productSelect.value=selected;
 const supplierSelect=$("#receipt-form [name=supplier_id]");const sid=supplierSelect.value;
 supplierSelect.innerHTML='<option value="">Sin proveedor asignado</option>'+s.data.filter(x=>x.active).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join("");supplierSelect.value=sid;
}
async function labInit(){
 const me=await api("GET","/api/me");
 if(!me.ok||me.data.user?.role!=="admin"){$("#lab-guard").textContent="Acceso restringido a administradores. Iniciá sesión desde Mi cuenta.";return;}
 $("#lab-guard").classList.add("hidden");$("#lab-main").classList.remove("hidden");await labRefresh();
}
$("#supplier-form").addEventListener("submit",async e=>{
 e.preventDefault();const f=e.currentTarget,b=Object.fromEntries(new FormData(f));const r=await api("POST","/api/lab/suppliers",b);
 $("#supplier-msg").textContent=r.ok?"Proveedor guardado.":r.data.error||"Error";
 if(r.ok){f.reset();await labRefresh();}
});
$("#receipt-form").addEventListener("submit",async e=>{
 e.preventDefault();const f=e.currentTarget,b=Object.fromEntries(new FormData(f));const r=await api("POST","/api/lab/receipts",b);
 $("#receipt-msg").textContent=r.ok?`Recepción registrada. Stock actual: ${r.data.stock}.`:r.data.error||"Error";
 if(r.ok){f.elements.quantity.value="";f.elements.reference.value="";await labRefresh();}
});
labInit();
