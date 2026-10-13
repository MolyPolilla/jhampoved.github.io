# Cambios

## v0.6 — MFA TOTP para administradores
- MFA TOTP obligatorio para `admin`: sesión pendiente sin privilegios hasta verificar el código; anti-replay; bloqueo tras 5 fallos; 8 códigos de recuperación de un solo uso (solo hash en SQLite).
- Secreto TOTP cifrado en reposo (AES-256-GCM; clave de `MOCCI_DATA_KEY` por HKDF o `moccimoth.db.mfa.key` 600). Nunca en claro.
- Rutas nuevas: `POST /api/login/mfa`, `/api/admin/mfa/setup`, `/api/admin/mfa/enable`. `/api/login` y `/api/me` devuelven `pending: "mfa" | "enroll" | null`.
- Auditoría: `mfa_enabled`, `mfa_login_ok`, `mfa_failed`, `mfa_enroll_failed`, `mfa_recovery_used`.
- `npm run reset-admin -- --reset-mfa` para perder el autenticador (solo local); invalida sesiones.
- Migración no destructiva (4 columnas en `users`). Mi cuenta: formularios de código y de activación.
- Pruebas: `tests/mfa.test.js` (14) y ajuste de las existentes para el segundo factor. Ver `MFA-TOTP.md`.

## v0.4 — actualización de seguridad (esta entrega)
- Protección CSRF con token por sesión para toda operación autenticada que cambia datos (+ verificación de origen que ya existía).
- Cookie de sesión `Secure` automática en HTTPS / proxy de confianza; sin `Secure` en localhost por HTTP.
- `scripts/reset-admin-password.js` (`npm run reset-admin`): recuperación local de la clave admin, sin borrar SQLite y con copia de seguridad.
- 18 pruebas automáticas (`npm test`): permisos, CSRF, cookies, descuentos, stock, checkout y recuperación.
- Sin cambios de esquema SQLite, de diseño ni de estilos. Archivos modificados: `server.js`, `public/common.js`, `package.json`, `README.md`. Archivos nuevos: `scripts/`, `tests/`, `CHANGELOG.md`.

## Pendiente para v0.4.1 (documentado, no implementado a propósito)
- **Sesiones persistentes**: hoy viven en memoria (reiniciar el servidor cierra todas, lo que además sirve tras `reset-admin`). Persistirlas pide una tabla nueva (migración).
- **CSRF también en login/registro/setup** (hoy solo protegidos por la verificación de origen). Riesgo bajo, pero requiere un token previo a la sesión y tocar `account.js`.
- Prefijo de cookie `__Host-sid` y cabecera `Strict-Transport-Security` cuando se sirva por HTTPS (cambiaría el nombre de la cookie: cierra las sesiones activas).
- Bloqueo de intentos detrás de un proxy: la clave usa la IP del socket; con proxy habría que leer `X-Forwarded-For` de forma confiable.
- Unificar la regla de clave: el alta del admin pide 8+ caracteres y el panel/recuperación 10+ con letras y números.
- Límite de registros por IP.
