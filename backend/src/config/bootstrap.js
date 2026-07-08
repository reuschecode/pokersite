'use strict';

// Auto-provisionamiento al arrancar (idempotente): crea el admin, siembra los
// bots y una mesa por defecto SOLO si faltan. Pensado para que una base nueva
// en producción quede lista sin correr scripts a mano.

const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { seedBots } = require('../../seedBots');

async function bootstrap() {
  // ── Admin (desde variables de entorno; nunca contraseña en el código) ──
  const [[adm]] = await pool.query('SELECT COUNT(*) n FROM players WHERE is_admin = 1');
  if (adm.n === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@pokersite.com').toLowerCase();
    const pass = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(pass, 10);
    await pool.query(
      `INSERT INTO players (id, email, nickname, password_hash, play_chips, real_chips, is_admin)
       VALUES (?, ?, 'Admin', ?, 100000, 0, 1)
       ON DUPLICATE KEY UPDATE is_admin = 1, password_hash = VALUES(password_hash)`,
      [uuidv4(), email, hash]
    );
    console.log(`[bootstrap] Admin listo: ${email}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[bootstrap] ⚠️  ADMIN_PASSWORD no definido — se usó "admin123". ¡Defínela en el entorno y reinicia!');
    }
  }

  // ── Bots (100) si la tabla está vacía ──
  const [[b]] = await pool.query('SELECT COUNT(*) n FROM bots');
  if (b.n === 0) {
    console.log('[bootstrap] Sembrando 100 bots…');
    try { await seedBots(); } catch (e) { console.error('[bootstrap] seedBots:', e.message); }
  }

  // ── Una mesa cash por defecto si no hay ninguna pública ──
  const [[t]] = await pool.query("SELECT COUNT(*) n FROM tables_cash WHERE invite_code IS NULL");
  if (t.n === 0) {
    await pool.query(
      `INSERT INTO tables_cash (id, name, game_type, chip_mode, max_seats, small_blind, big_blind, buy_in_min, buy_in_max)
       VALUES (?, 'Mesa Principal', 'holdem', 'play', 6, 5, 10, 200, 2000)`,
      [uuidv4()]
    );
    console.log('[bootstrap] Mesa Principal creada.');
  }
}

module.exports = bootstrap;
