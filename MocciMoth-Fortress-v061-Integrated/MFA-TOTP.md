# MFA TOTP para administradores (v0.6)

**Obligatorio** para toda cuenta `admin`. Compatible con Google Authenticator, Aegis, 2FAS, Authy, etc. Sin dependencias nuevas.

## Cómo funciona
- Al iniciar sesión, un admin solo con contraseña recibe una sesión **pendiente**: no puede usar ninguna ruta de administración, ni Mi cuenta/pedidos (`401 mfa_required`).
- **Primera vez:** Mi cuenta → clave de configuración → cargarla en la app (*ingresar clave manualmente*) → escribir el código de 6 dígitos → se muestran **8 códigos de recuperación (una sola vez)**. Guardalos fuera de la computadora.
- **Siguientes ingresos:** contraseña + código de 6 dígitos (o un código de recuperación).
- Un código TOTP **no se puede reutilizar**; se tolera ±30 s de diferencia de reloj.
- **5 códigos erróneos** bloquean el segundo factor 5 minutos. Quedan registrados en `audit_logs` (`mfa_enabled`, `mfa_login_ok`, `mfa_failed`, `mfa_recovery_used`) sin guardar códigos.
- Al subir de nivel (y al activar MFA) se emite un identificador de sesión nuevo; activar MFA cierra las demás sesiones del admin.
- Los clientes normales no usan MFA y no se ven afectados.

## Dónde se guarda
- El secreto TOTP se cifra con AES-256-GCM (ligado al id del usuario) y **nunca** se guarda en claro, aunque no tengas `MOCCI_DATA_KEY`.
- Con `MOCCI_DATA_KEY` configurada se usa una subclave derivada de ella (HKDF). Sin ella se crea `moccimoth.db.mfa.key` (permisos 600) junto a la base.
- Los códigos de recuperación se guardan solo como hash SHA-256.
- **Respaldos:** guardá la clave (`MOCCI_DATA_KEY` o `moccimoth.db.mfa.key`) junto a tus respaldos de la base. Si restaurás la base sin ella, el servidor responde con un mensaje claro y se recupera con el comando de abajo.

## Si perdés el celular y los códigos
Con acceso a la máquina del servidor (no existe ruta web para esto):
```
npm.cmd run reset-admin -- --reset-mfa
```
Cambia la contraseña, borra el segundo factor, cierra todas las sesiones y exige activarlo de nuevo al próximo ingreso. Sin `--reset-mfa`, el comando de recuperación de contraseña **conserva** el MFA.

## Migración
Automática y sin borrar datos: agrega 4 columnas a `users` (`totp_secret_enc`, `totp_enabled`, `totp_last_step`, `recovery_hashes`). **Los admin existentes activan MFA en su próximo ingreso.**

## Pruebas
`npm.cmd test` → incluye `tests/mfa.test.js` (14 pruebas: vectores RFC 6238, cifrado, activación, login, anti-replay, recuperación, bloqueo, CSRF, sesiones, `--reset-mfa`, auditoría).

## Límites conocidos
- No hay código QR (evita agregar una dependencia): se carga la clave manualmente.
- No hay "regenerar códigos de recuperación" ni "desactivar MFA" desde la web; se hace con `--reset-mfa`.
- El bloqueo por intentos y los límites por IP viven en memoria (se reinician al reiniciar el servidor).
