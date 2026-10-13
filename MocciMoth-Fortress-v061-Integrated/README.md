# MocciMoth v0.4 🦋 (laboratorio educativo — tienda ficticia)

## Abrir en VS Code
1. Abrí la carpeta `MocciMoth-v03` en VS Code.
2. Terminal → Nueva terminal.
3. Ejecutá `npm.cmd start` (Windows) o `npm start`.
4. Abrí `http://127.0.0.1:3000`.

Sin `npm install`, sin dependencias. Requiere Node con `node:sqlite` (Node 24 recomendado).
La base `moccimoth.db` se crea sola y **se migra** (agrega columnas nuevas sin borrar tus datos).

## Administrador (sin credenciales en el código)
Primera vez: **Mi cuenta → crear administrador local**. La contraseña se guarda como hash scrypt + salt. Si se configura `MOCCI_TRUST_PROXY=1`, también se requiere un token de instalación de un solo uso en `MOCCI_SETUP_TOKEN`; generá uno con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, configurálo en el entorno del servidor y escribilo en el formulario. Se elimina del proceso al crear el administrador. No lo publiques ni lo guardes en el repositorio.
Para cambiarla: **Panel admin → Seguridad** (pide la contraseña actual, exige 10+ caracteres con letras y números y cierra las otras sesiones).

### Si olvidaste la contraseña del admin (solo local)
```
npm run reset-admin            # o: node scripts/reset-admin-password.js admin@correo
```
- Solo funciona en la máquina que tiene `moccimoth.db`; **no existe ninguna ruta web** para esto.
- No borra ni recrea la base: actualiza únicamente el hash del admin y deja antes una copia `moccimoth.db.bak-<fecha>`.
- Pide la clave por teclado (mismas reglas que el panel). Después reiniciá el servidor para cerrar sesiones abiertas.

## Qué incluye
- Carrito: agregar, +/−, eliminar, vaciar, imágenes, stock, persistente en `localStorage` (solo `{id: cantidad}`).
- Descuentos: 1–2 u. = 0%, 3–4 = 10%, 5–7 = 20%, 8+ = 25%. **El servidor recalcula todo** en `/api/cart/quote` y `/api/checkout`.
- Checkout SIMULADO en 5 pasos: resumen → envío → pago → confirmar → comprobante con número de pedido.
- Pedidos, productos, cantidades, descuento, fecha y estado en SQLite.
- Admin: crear/editar/eliminar productos, subir imágenes (PNG/JPG/WEBP/GIF, 4 MB, verificadas por contenido), stock, pedidos y contraseña.
- Íconos SVG estilo Lucide en `public/icons.svg`; GIFs rosas nuevos en `public/assets/gifs/`.

## Seguridad (versión sin vulnerabilidades intencionales)
- SQL 100% parametrizado; contraseñas con scrypt; autorización siempre en el servidor.
- El navegador nunca decide precios, descuentos ni stock.
- Tarjetas: solo se aceptan números de **prueba** (4242 4242 4242 4242, 5555 5555 5555 4444, 3782 822463 10005). Se guardan solo marca y últimos 4; el número completo y el CVV se descartan.
- Todo texto dinámico se escapa en el frontend; CSP sin scripts inline; cabeceras `nosniff`, `X-Frame-Options`.
- Sesiones con vencimiento (8 h), bloqueo tras 5 intentos fallidos.
- **CSRF (v0.4):** además de verificar el origen, toda operación autenticada que cambia datos exige el header `X-CSRF-Token` (token propio de cada sesión, se obtiene en `/api/me` y al iniciar sesión; `common.js` lo envía solo).
- **Cookies según entorno:** `HttpOnly` + `SameSite=Lax` siempre. En `http://127.0.0.1` no llevan `Secure` (el navegador las descartaría); con HTTPS directo, detrás de un proxy (`MOCCI_TRUST_PROXY=1` + `X-Forwarded-Proto: https`) o con `MOCCI_COOKIE_SECURE=1`, se agrega `Secure`.

## Pruebas automáticas
`npm test` (sin dependencias, usa `node:test`). Levanta el servidor con una base **temporal**: no toca tu `moccimoth.db`.
Cubren permisos (anónimo / cliente / admin), CSRF, cookies, descuentos, stock, checkout y la recuperación local de la clave.

Para reiniciar el laboratorio: Ctrl+C, borrá `moccimoth.db` y volvé a iniciar.
