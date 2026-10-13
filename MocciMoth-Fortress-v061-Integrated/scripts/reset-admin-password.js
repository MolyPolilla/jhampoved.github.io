"use strict";
/* MocciMoth — recuperación LOCAL de la contraseña del administrador.
   Uso:   npm run reset-admin            (o: node scripts/reset-admin-password.js [email])
   - Solo se puede ejecutar en la máquina que tiene el archivo moccimoth.db (no existe ruta HTTP).
   - NO borra ni recrea la base: hace un UPDATE del hash y deja una copia de seguridad antes.
   - Pide la contraseña por teclado (no queda en el historial ni en variables de entorno). */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE = process.env.MOCCI_DB || path.join(__dirname, "..", "moccimoth.db");

function ask(rl, question, hidden) {
  return new Promise((resolve) => {
    if (hidden && process.stdout.isTTY) {
      const orig = rl._writeToOutput;
      process.stdout.write(question);
      rl._writeToOutput = () => {};
      rl.question("", (a) => { rl._writeToOutput = orig; process.stdout.write("\n"); resolve(a); });
    } else rl.question(question, resolve);
  });
}
// Mismas reglas que el panel admin (Seguridad).
function problemaClave(nueva, email) {
  if (nueva.length < 10) return "Usá al menos 10 caracteres.";
  if (!/[A-Za-z]/.test(nueva) || !/\d/.test(nueva)) return "Combiná letras y números.";
  if (nueva.toLowerCase().includes(email.split("@")[0].toLowerCase())) return "No uses tu email dentro de la contraseña.";
  return null;
}

(async () => {
  if (!fs.existsSync(DB_FILE)) { console.error(`No encontré la base: ${DB_FILE}\nIniciá la tienda una vez (npm start) para crearla.`); process.exit(1); }
  const db = new DatabaseSync(DB_FILE);
  const admins = db.prepare("SELECT id,nombre,email FROM users WHERE role='admin' ORDER BY id").all();
  if (!admins.length) { console.error("No hay administrador. Creálo desde Mi cuenta → crear administrador local."); process.exit(1); }

  const RESET_MFA = process.argv.includes("--reset-mfa");
  const wanted = (process.argv.slice(2).find((a) => !a.startsWith("--")) || "").trim().toLowerCase();
  let admin = admins.length === 1 && !wanted ? admins[0] : admins.find((a) => a.email === wanted);
  if (!admin) {
    console.error(wanted ? `No hay un administrador con el email ${wanted}.` : "Hay varios administradores; indicá cuál:");
    admins.forEach((a) => console.error(`  - ${a.email}`));
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  rl.on("close", () => {}); // no hace falta nada, pero evita cortar con entrada redirigida
  const lines = [];
  if (!process.stdin.isTTY) rl.on("line", (l) => lines.push(l));
  const prompt = async (q, hidden) => (process.stdin.isTTY ? ask(rl, q, hidden) : (process.stdout.write(q + "\n"), new Promise((r) => { const t = setInterval(() => { if (lines.length) { clearInterval(t); r(lines.shift()); } }, 5); })));

  console.log(`Restablecer contraseña de: ${admin.email}`);
  const nueva = await prompt("Nueva contraseña: ", true);
  const conf = await prompt("Repetila: ", true);
  rl.close();
  const err = nueva !== conf ? "Las contraseñas no coinciden." : problemaClave(nueva, admin.email);
  if (err) { console.error(err); process.exit(1); }

  const backup = `${DB_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(DB_FILE, backup);
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(nueva, salt, 64).toString("hex"); // mismo formato que server.js
  const cols = db.prepare("PRAGMA table_info(users)").all().map(x => x.name);
  if (!cols.includes("session_version")) db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
  const r = db.prepare("UPDATE users SET password_hash=?,salt=?,session_version=session_version+1 WHERE id=? AND role='admin'").run(hash, salt, admin.id);
  if (r.changes !== 1) { console.error("No se pudo actualizar."); process.exit(1); }
  if (RESET_MFA) {
    // Pérdida del autenticador: se borra el segundo factor; en el próximo login el admin lo activa de nuevo.
    for (const [c, def] of [["totp_secret_enc", "TEXT NOT NULL DEFAULT ''"], ["totp_enabled", "INTEGER NOT NULL DEFAULT 0"], ["totp_last_step", "INTEGER NOT NULL DEFAULT 0"], ["recovery_hashes", "TEXT NOT NULL DEFAULT '[]'"]]) {
      if (!cols.includes(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${def}`);
    }
    db.prepare("UPDATE users SET totp_enabled=0,totp_secret_enc='',totp_last_step=0,recovery_hashes='[]' WHERE id=?").run(admin.id);
    console.log("Verificación en dos pasos reiniciada: el administrador deberá activarla de nuevo al iniciar sesión.");
  }
  console.log(`Listo. Contraseña actualizada. Copia de seguridad: ${path.basename(backup)}`);
  console.log("Todas las sesiones anteriores de esa cuenta quedan invalidadas automáticamente.");
})();
