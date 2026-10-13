# Mocci Lab — inventario conectado

Entrá como administrador y abrí `/lab.html` o el enlace desde `/admin.html`.

- Proveedores ficticios y sus contactos.
- Recepción de stock: elegí producto, proveedor opcional, cantidad y una **referencia única** por entrega.
- La recepción suma unidades a `products.stock` en la misma base SQLite que consulta la tienda. La página de la tienda mostrará el nuevo stock en la próxima consulta/recarga.
- Estadísticas de pedidos ficticios y productos más pedidos.
- Auditoría de cada recepción y creación de proveedor.

**Seguridad:** todos los endpoints `/api/lab/*` exigen administrador y CSRF en cambios. La referencia única evita duplicar una recepción. Las operaciones de stock se ejecutan en transacciones SQLite.

**Actualización:** hacé una copia de `moccimoth.db` antes de sustituir archivos. No copies ni reemplaces la base existente. Las tablas nuevas se crean automáticamente al arrancar.

**Pendiente:** gestión de órdenes de compra, informes exportables, MFA y notificaciones en tiempo real (la tienda se actualiza al consultar nuevamente el catálogo).
