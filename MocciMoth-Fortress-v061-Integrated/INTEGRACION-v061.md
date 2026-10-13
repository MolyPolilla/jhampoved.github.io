# MocciMoth Fortress v0.6.1 — integración MFA + Mocci Lab

Integra el proyecto v0.6 completo (Boutique, HTTPS, cifrado de campos, Mocci Lab) con el parche TOTP de Claude. Corrige explícitamente la sesión MFA al cambiar contraseña administrativa.

## Actualizar sin perder datos
1. Detené el servidor. Respaldá **toda** tu carpeta, especialmente `moccimoth.db`, claves (`MOCCI_DATA_KEY` o `moccimoth.db.mfa.key`) y certificados.
2. Copiá el contenido de esta carpeta sobre la instalación v0.6. **No sobrescribas ni elimines** la base SQLite, `.env`, certificados ni claves privadas.
3. Ejecutá `npm.cmd test` y luego `npm.cmd start` (Windows).
4. Iniciá sesión como administrador y seguí `MFA-TOTP.md` para activar TOTP. Guardá los códigos de recuperación fuera de la PC.
5. Comprobá `/lab.html`, la recepción de mercadería, el catálogo y HTTPS desde el dispositivo que usarás.

**Tipografías:** este paquete no redistribuye archivos de fuentes. Si disponés de licencias válidas, podés colocar tus fuentes en `public/assets/fonts/` con los nombres esperados por `public/style.css`; sin ellas el navegador usará las fuentes de respaldo. Monimer es de uso personal según el archivo original de licencia.

**Seguridad:** 37 pruebas automatizadas pasan en el entorno de construcción; esto no equivale a una auditoría completa ni a un despliegue público seguro. HTTPS requiere certificados y configuración del equipo; leé `HTTPS-Y-CIFRADO.md`.
