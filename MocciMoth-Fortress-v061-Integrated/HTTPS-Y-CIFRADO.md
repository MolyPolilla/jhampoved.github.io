# MocciMoth Fortress v0.5.2 — HTTPS y cifrado de campos

## Qué protege
- HTTPS cifra tráfico navegador-servidor y habilita cookies `Secure`. **HTTP solo se permite en loopback** (127.0.0.1), para desarrollo.
- AES-256-GCM cifra **teléfono y dirección del perfil**, además de **teléfono y dirección de envío** de pedidos. No cifra todo SQLite, los correos, nombres, estadísticas ni el resto de campos. Las contraseñas continúan hasheadas.
- Las claves privadas y `MOCCI_DATA_KEY` **NO vienen en el ZIP**. Nunca las subas a Netlify/GitHub ni las compartas.
- Sin `MOCCI_DATA_KEY`, se mantiene el funcionamiento anterior y **los nuevos campos se guardan sin cifrar**. Para activar el cifrado, configurá la clave y migrá los datos existentes.

## HTTPS local en Windows / PowerShell
Se necesita **OpenSSL** disponible en el sistema para generar certificados; no se incluye ningún certificado privado. Alternativamente podés usar un certificado local emitido por una herramienta confiable como mkcert.

1. Detené Node y hacé una copia de tu carpeta y de `moccimoth.db`.
2. En la carpeta raíz del proyecto, generá un certificado de prueba (solo para localhost):

```powershell
mkdir certs
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -keyout certs/local-key.pem -out certs/local-cert.pem -days 30 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

3. En **esa misma terminal**, configurá rutas y arrancá:

```powershell
$env:MOCCI_TLS_CERT = (Resolve-Path .\certs\local-cert.pem).Path
$env:MOCCI_TLS_KEY = (Resolve-Path .\certs\local-key.pem).Path
npm.cmd start
```

4. Abrí `https://localhost:3000`. El navegador **advertirá** que el certificado autofirmado no es confiable; no lo confundas con un certificado público válido. Para un laboratorio con otra PC, generá un certificado válido para el nombre/IP real y confiable en los dispositivos del laboratorio, y configurá `MOCCI_HOST` según el entorno. **No uses HTTP en Wi-Fi compartida.**

Para volver a HTTP de desarrollo local, abrí una terminal nueva sin las variables TLS y ejecutá `npm.cmd start`; solo escuchará en 127.0.0.1.

## Cifrado de campos y migración segura

**No perdás la clave:** perderla impide leer datos cifrados. El servidor no guarda la clave en SQLite. Guardala en un gestor seguro fuera del proyecto.

Generá una clave aleatoria desde PowerShell, en la terminal donde arrancarás Node:

```powershell
$env:MOCCI_DATA_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

**Atención:** esta variable dura solo durante la sesión de esa terminal. Guardá la clave en un lugar seguro antes de cerrarla. No la pegues en el código ni la subas al repositorio.

Con el servidor **detenido** y la clave ya configurada:

```powershell
node scripts/encrypt-existing-data.js
npm.cmd test
npm.cmd start
```

El script comprueba si hay datos cifrados con otra clave, crea un respaldo consistente de SQLite y migra los datos anteriores sin eliminar pedidos ni usuarios. La migración puede ejecutarse nuevamente con la misma clave. **No la ejecutes mientras el servidor está funcionando.**

Si ya existen datos cifrados, **siempre** configurá la misma `MOCCI_DATA_KEY` antes de arrancar o migrar. El servidor puede leer registros anteriores sin cifrar, pero no podrá descifrar los cifrados si falta la clave.

## Limitaciones
- Un atacante con control del proceso Node o acceso a su clave podría leer los campos cifrados. El cifrado de aplicación no reemplaza permisos, copias de seguridad, MFA ni TLS.
- HTTPS no impide que alguien use una sesión ya robada. MFA administrativo aún está pendiente.
- La configuración de alta inicial del administrador ahora se limita a la máquina local; aún conviene añadir un mecanismo de instalación con secreto de un solo uso.
- Los pagos siguen siendo demostrativos, sin cargos reales.
