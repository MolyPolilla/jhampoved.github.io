# MocciMoth Fortress 0.5.0-alpha — entrega incremental

Esta es una primera etapa, NO una versión lista para exposición pública.

## Implementado
- Migración no destructiva `users.session_version`: la sesión se comprueba contra SQLite en cada petición. Un restablecimiento local de contraseña incrementa esa versión e invalida inmediatamente sesiones previas, incluso con el servidor en ejecución.
- El cambio de contraseña en el panel también incrementa la versión e inicia una sesión nueva.
- `audit_logs` en SQLite y ruta administrativa `GET /api/admin/audit` (solo lectura, hasta 100 eventos): creación, edición, borrado, stock y cambio de contraseña. No almacena secretos.
- Límites básicos por IP y minuto para login, registro y checkout. Son protección inicial en memoria, no sustituyen un proxy o controles distribuidos.
- Manejo de error de lectura de archivos estáticos.
- Dos pruebas adicionales de invalidación y auditoría; 20 pruebas ejecutadas correctamente en Node 22.16.0 (el proyecto está diseñado para Node 24).

## Pendiente, prioritario
- ~~MFA TOTP para administradores~~ → hecho en v0.6, ver `MFA-TOTP.md` (recuperación local con `--reset-mfa`).
- HTTPS para uso en LAN: actualmente escucha **solo** en 127.0.0.1 mediante HTTP. No exponer en red compartida ni cambiar el HOST a 0.0.0.0 sin TLS.
- Protección reforzada del alta inicial del administrador; usar setup solo en máquina propia antes de compartir el servidor.
- Rate limiting persistente, hash de contraseñas asíncrono y límites por cuenta.
- Mejoras de diseño y fuentes; CSP y limpieza de estilos inline.
- Pruebas manuales en navegador y auditoría independiente antes de desplegar.

## Instalación
1. Extraer ZIP y abrir la carpeta que contiene `server.js`.
2. Si tenés datos previos, detener el servidor y hacer copia de `moccimoth.db` **antes** de reemplazar archivos. No viene ninguna base de datos en el ZIP.
3. Reemplazar archivos del proyecto, conservar la base original en la carpeta raíz.
4. En PowerShell: `npm.cmd test`, luego `npm.cmd start`.
5. Abrir `http://127.0.0.1:3000`.

El servidor aplica las migraciones de columnas y tablas sin borrar los datos existentes. No se han añadido dependencias npm.
