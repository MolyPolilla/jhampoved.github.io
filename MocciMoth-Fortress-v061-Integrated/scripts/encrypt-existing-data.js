"use strict";
// Ejecutar solo con servidor detenido y MOCCI_DATA_KEY configurada.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { seal, unseal } = require("../lib/private-fields");
if (!process.env.MOCCI_DATA_KEY) { console.error("Falta MOCCI_DATA_KEY. No se modificó nada."); process.exit(1); }
const dbFile = process.env.MOCCI_DB || path.join(__dirname, "..", "moccimoth.db");
if (!fs.existsSync(dbFile)) { console.error("No existe la base de datos."); process.exit(1); }
const db = new DatabaseSync(dbFile);
// Verificar que la clave actual puede descifrar registros ya cifrados ANTES de modificar.
for (const [table, columns] of [["users", ["telefono", "direccion"]], ["orders", ["direccion_envio", "envio_telefono"]]]) {
  for (const row of db.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()) {
    for (const col of columns) unseal(row[col]);
  }
}
const backup = dbFile + ".before-encryption-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db";
// Backup consistente, también si la DB tenía WAL.
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
let count = 0;
db.exec("BEGIN IMMEDIATE");
try {
  for (const [table, columns] of [["users", ["telefono", "direccion"]], ["orders", ["direccion_envio", "envio_telefono"]]]) {
    const rows = db.prepare(`SELECT id,${columns.join(",")} FROM ${table}`).all();
    const update = db.prepare(`UPDATE ${table} SET ${columns.map(c => c + "=?").join(",")} WHERE id=?`);
    for (const row of rows) {
      const vals = columns.map(col => seal(row[col]));
      if (vals.some((v, i) => v !== row[columns[i]])) { update.run(...vals, row.id); count++; }
    }
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); console.error("Migración cancelada:", e.message); process.exitCode = 1; }
console.log(`Filas cifradas: ${count}. Respaldo: ${backup}`);
db.close();
