'use strict';

const pool = require('../config/db');
const botManager = require('../engine/bot/BotManager');
const tm = require('../engine/tableManager');

// POST /admin/bots/seat  { tableId, level, count, buyIn? }
async function seatBots(req, res) {
  const { tableId, level, count = 1, buyIn } = req.body;
  if (!tableId) return res.status(400).json({ error: 'tableId requerido' });
  if (![5, 6, 7, 8, 9, 10].includes(Number(level))) return res.status(400).json({ error: 'Nivel debe ser 5-10' });
  const n = Math.max(1, Math.min(Number(count) || 1, 8));
  if (!tm.getTable(tableId)) return res.status(404).json({ error: 'Mesa no encontrada (¿está creada y viva?)' });
  const result = await botManager.seatBots({ tableId, level: Number(level), count: n, buyIn: buyIn ? Number(buyIn) : undefined });
  res.json(result);
}

// POST /admin/bots/unseat  { tableId }  ó  { ids: [...] }
async function unseatBots(req, res) {
  const { tableId, ids } = req.body;
  if (!tableId && !ids) return res.status(400).json({ error: 'tableId o ids requerido' });
  res.json(botManager.unseatBots({ tableId, ids }));
}

// GET /admin/bots  → bots vivos (con nivel, solo admin)
async function listActiveBots(req, res) {
  res.json(botManager.listActive());
}

// GET /admin/labels/accuracy → compara nivel adivinado por cada tester vs nivel real
async function labelAccuracy(req, res) {
  const [rows] = await pool.query(
    `SELECT t.tester_id, pt.nickname AS tester_nick,
            t.target_id, po.nickname AS target_nick,
            t.estimated_level, b.level AS real_level
     FROM tester_labels t
     JOIN players pt ON pt.id = t.tester_id
     JOIN players po ON po.id = t.target_id
     JOIN bots b ON b.bot_id = t.target_id
     WHERE t.estimated_level IS NOT NULL
     ORDER BY pt.nickname, po.nickname`
  );
  // Resumen de precisión por tester
  const byTester = {};
  for (const r of rows) {
    const k = r.tester_id;
    if (!byTester[k]) byTester[k] = { tester: r.tester_nick, total: 0, exactos: 0, cerca: 0, sumaError: 0, detalle: [] };
    const err = Math.abs(r.estimated_level - r.real_level);
    byTester[k].total++;
    if (err === 0) byTester[k].exactos++;
    if (err <= 1) byTester[k].cerca++;
    byTester[k].sumaError += err;
    byTester[k].detalle.push({ bot: r.target_nick, adivinado: r.estimated_level, real: r.real_level, error: err });
  }
  const resumen = Object.values(byTester).map(t => ({
    ...t,
    errorPromedio: t.total ? +(t.sumaError / t.total).toFixed(2) : 0,
  }));
  res.json(resumen);
}

// GET /admin/dashboard → panorama en vivo del sistema
async function dashboard(req, res) {
  const [[players]] = await pool.query(
    'SELECT COUNT(*) total, SUM(is_bot=0) humanos, SUM(is_bot=1) bots FROM players'
  );
  const [[chips]] = await pool.query(
    'SELECT SUM(play_chips) circulacion FROM players WHERE is_bot = 0'
  );
  const [[handsToday]] = await pool.query(
    'SELECT COUNT(*) n FROM hand_history WHERE ended_at >= CURDATE()'
  );
  const [[handsTotal]] = await pool.query('SELECT COUNT(*) n FROM hand_history');
  const [tourneys] = await pool.query(
    `SELECT name, status, prize_pool,
       (SELECT COUNT(*) FROM tournament_registrations r WHERE r.tournament_id = t.id) regs
     FROM tournaments t WHERE status IN ('registering','running') ORDER BY created_at DESC LIMIT 10`
  );
  const [lastTx] = await pool.query(
    `SELECT ct.delta, ct.reason, ct.created_at, p.nickname
     FROM chip_transactions ct JOIN players p ON p.id = ct.player_id
     ORDER BY ct.id DESC LIMIT 12`
  );
  // Mesas vivas en memoria (con gente sentada)
  const liveTables = tm.getAllTables()
    .map(t => ({
      id: t.id, name: t.name, isTournament: !!t.isTournament, handNumber: t.handNumber || 0,
      seated: t.seats.filter(s => s.playerId).length, maxSeats: t.seats.length,
    }))
    .filter(t => t.seated > 0);
  res.json({
    players: { total: players.total, humanos: players.humanos, bots: players.bots },
    chipsCirculacion: Number(chips.circulacion) || 0,
    manosHoy: handsToday.n,
    manosTotal: handsTotal.n,
    botsActivos: botManager.listActive().length,
    mesasVivas: liveTables,
    torneos: tourneys,
    ultimasTransacciones: lastTx,
  });
}

module.exports = { seatBots, unseatBots, listActiveBots, labelAccuracy, dashboard };
