'use strict';

const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const { startTournament, DEFAULT_BLINDS, defaultPayout, getPlayerTable, getStandings, isLateRegOpen, lateJoin } = require('../engine/tournamentManager');

const MAX_FIELD = 30; // hasta 5 mesas de 6

// Jugador desde el token si viene (la ruta de lista es pública)
function playerFromReq(req) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    return token ? jwt.verify(token, process.env.JWT_SECRET) : null;
  } catch { return null; }
}

// GET /tournaments  → lista (con nº de inscritos + mi estado si hay token)
async function listTournaments(req, res) {
  const [rows] = await pool.query(
    `SELECT t.*, (SELECT COUNT(*) FROM tournament_registrations r WHERE r.tournament_id = t.id) AS registered
     FROM tournaments t
     WHERE t.status IN ('registering','running')
     ORDER BY t.created_at DESC LIMIT 50`
  );
  const me = playerFromReq(req);
  let myRegs = new Map();
  if (me && rows.length) {
    const ids = rows.map(r => r.id);
    const [regs] = await pool.query(
      `SELECT tournament_id, final_position FROM tournament_registrations
       WHERE player_id = ? AND tournament_id IN (${ids.map(() => '?').join(',')})`,
      [me.id, ...ids]
    );
    myRegs = new Map(regs.map(r => [r.tournament_id, r]));
  }
  res.json(rows.map(t => {
    const reg = myRegs.get(t.id);
    return {
      ...t,
      am_registered: !!reg,
      my_final_position: reg?.final_position ?? null,
      late_reg_open: t.status === 'running' ? isLateRegOpen(t.id) : false,
    };
  }));
}

// GET /tournaments/:id  → detalle + inscritos
async function getTournament(req, res) {
  const [rows] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Torneo no encontrado' });
  const [regs] = await pool.query(
    `SELECT r.player_id, p.nickname, r.final_position, r.prize_won
     FROM tournament_registrations r JOIN players p ON p.id = r.player_id
     WHERE r.tournament_id = ? ORDER BY r.registered_at`,
    [req.params.id]
  );
  res.json({ ...rows[0], registrations: regs });
}

// ── Programación de inicio por fecha/hora ──
const startSchedules = new Map(); // tournamentId → timer

function scheduleStart(id, whenMs) {
  const prev = startSchedules.get(id);
  if (prev) clearTimeout(prev);
  const delay = Math.max(0, whenMs - Date.now());
  if (delay > 2147483647) return; // demasiado lejos; se reprograma al reiniciar
  const timer = setTimeout(() => {
    startSchedules.delete(id);
    fireScheduledStart(id).catch(e => console.error('[torneo programado]', e.message));
  }, delay);
  startSchedules.set(id, timer);
}

// A la hora programada: rellena los cupos libres con bots variados y arranca.
async function fireScheduledStart(id) {
  const [[t]] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [id]);
  if (!t || t.status !== 'registering') return; // ya arrancó/cancelado
  const [[cnt]] = await pool.query('SELECT COUNT(*) n FROM tournament_registrations WHERE tournament_id = ?', [id]);
  const room = t.max_players - cnt.n;
  if (room > 0) {
    const [bots] = await pool.query(
      `SELECT bot_id FROM bots
       WHERE bot_id NOT IN (SELECT player_id FROM tournament_registrations WHERE tournament_id = ?)
       ORDER BY RAND() LIMIT ?`,
      [id, room]
    );
    for (const b of bots) { try { await registerPlayer(id, b.bot_id); } catch {} }
  }
  await startTournament(id).catch(e => console.error('[torneo programado start]', e.message));
}

// Al arrancar el servidor: reprograma los torneos con hora futura.
async function initScheduler() {
  try {
    const [rows] = await pool.query(
      "SELECT id, starts_at FROM tournaments WHERE status = 'registering' AND starts_at IS NOT NULL"
    );
    for (const r of rows) {
      const whenMs = new Date(r.starts_at).getTime();
      scheduleStart(r.id, Math.max(whenMs, Date.now() + 3000)); // si ya pasó, en 3s
    }
    if (rows.length) console.log(`[Torneos] ${rows.length} inicio(s) programado(s) reprogramados`);
  } catch (e) { console.error('[Torneos] initScheduler:', e.message); }
}

// POST /tournaments  (admin) → crear Sit&Go
// Opcionales: startsAt (inicio programado), buyIn=0 (freeroll),
// addedPrize (premio que aporta la casa), bounty (recompensa por eliminación).
async function createTournament(req, res) {
  const { name, maxPlayers = 6, blindSchedule = null, startsAt = null } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const max = Math.min(Math.max(Number(maxPlayers) || 6, 2), MAX_FIELD);
  const buyInNum = req.body.buyIn === undefined ? 100 : Math.max(0, Number(req.body.buyIn) || 0);
  const bountyNum = Math.max(0, Number(req.body.bounty) || 0);
  const addedPrize = Math.max(0, Number(req.body.addedPrize) || 0);
  if (bountyNum > buyInNum) return res.status(400).json({ error: 'El bounty no puede superar el buy-in' });
  if (buyInNum === 0 && addedPrize === 0) return res.status(400).json({ error: 'Un freeroll necesita premio añadido' });
  let startsAtDate = null;
  if (startsAt) {
    startsAtDate = new Date(startsAt);
    if (isNaN(startsAtDate.getTime())) return res.status(400).json({ error: 'Fecha/hora inválida' });
  }
  const id = uuidv4();
  const scheduleJson = JSON.stringify(Array.isArray(blindSchedule) && blindSchedule.length ? blindSchedule : DEFAULT_BLINDS);
  const payoutJson = JSON.stringify(defaultPayout(max));
  await pool.query(
    `INSERT INTO tournaments
       (id, name, game_type, chip_mode, tournament_type, max_players, min_players, buy_in, rake, prize_pool, payout_json, blind_schedule_json, status, starts_at, bounty, created_by)
     VALUES (?, ?, 'holdem', 'play', 'sit_and_go', ?, 2, ?, 0, ?, ?, ?, 'registering', ?, ?, ?)`,
    [id, name.trim(), max, buyInNum, addedPrize, payoutJson, scheduleJson, startsAtDate, bountyNum, req.player.id]
  );
  if (startsAtDate) scheduleStart(id, startsAtDate.getTime());
  res.status(201).json({ id, name: name.trim(), maxPlayers: max, buyIn: buyInNum, bounty: bountyNum, addedPrize, startsAt: startsAtDate });
}

// Inscribe a un jugador (cobra el buy-in a play_chips y suma al bote de premios)
async function registerPlayer(tournamentId, playerId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[t]] = await conn.query('SELECT * FROM tournaments WHERE id = ? FOR UPDATE', [tournamentId]);
    if (!t) throw { http: 404, msg: 'Torneo no encontrado' };
    if (t.status !== 'registering') throw { http: 400, msg: 'Inscripciones cerradas' };
    const [[cnt]] = await conn.query('SELECT COUNT(*) n FROM tournament_registrations WHERE tournament_id = ?', [tournamentId]);
    if (cnt.n >= t.max_players) throw { http: 400, msg: 'Torneo lleno' };
    const [[already]] = await conn.query('SELECT 1 x FROM tournament_registrations WHERE tournament_id = ? AND player_id = ?', [tournamentId, playerId]);
    if (already) throw { http: 400, msg: 'Ya estás inscrito' };
    const buyIn = parseFloat(t.buy_in) || 0;
    const [[p]] = await conn.query('SELECT play_chips FROM players WHERE id = ? FOR UPDATE', [playerId]);
    if (!p || p.play_chips < buyIn) throw { http: 400, msg: 'Fichas insuficientes para el buy-in' };
    await conn.query('UPDATE players SET play_chips = play_chips - ? WHERE id = ?', [buyIn, playerId]);
    await conn.query('INSERT INTO tournament_registrations (tournament_id, player_id) VALUES (?, ?)', [tournamentId, playerId]);
    // En torneos bounty, la parte de la recompensa se reserva (se paga al cazador)
    const poolAdd = Math.max(0, buyIn - (parseFloat(t.bounty) || 0));
    await conn.query('UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id = ?', [poolAdd, tournamentId]);
    await conn.query(
      `INSERT INTO chip_transactions (player_id, chip_mode, delta, reason, reference_id) VALUES (?, 'play', ?, 'tournament_buyin', ?)`,
      [playerId, -buyIn, tournamentId]
    );
    await conn.commit();
    return { newCount: cnt.n + 1, max: t.max_players };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Cobra el buy-in y registra/reactiva la inscripción de un late-reg / re-entry.
// Transaccional: si algo falla, no se descuentan fichas.
async function chargeLateEntry(t, playerId, reentry) {
  const buyIn = parseFloat(t.buy_in) || 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT play_chips FROM players WHERE id = ? FOR UPDATE', [playerId]);
    if (!p || p.play_chips < buyIn) throw { http: 400, msg: 'Fichas insuficientes para el buy-in' };
    await conn.query('UPDATE players SET play_chips = play_chips - ? WHERE id = ?', [buyIn, playerId]);
    if (reentry) {
      await conn.query(
        'UPDATE tournament_registrations SET final_position = NULL, prize_won = NULL WHERE tournament_id = ? AND player_id = ?',
        [t.id, playerId]
      );
    } else {
      await conn.query('INSERT INTO tournament_registrations (tournament_id, player_id) VALUES (?, ?)', [t.id, playerId]);
    }
    const poolAdd = Math.max(0, buyIn - (parseFloat(t.bounty) || 0));
    await conn.query('UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id = ?', [poolAdd, t.id]);
    await conn.query(
      `INSERT INTO chip_transactions (player_id, chip_mode, delta, reason, reference_id) VALUES (?, 'play', ?, 'tournament_buyin', ?)`,
      [playerId, -buyIn, t.id]
    );
    await conn.commit();
    return buyIn;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// POST /tournaments/:id/register  (el propio jugador)
// Tres caminos: inscripción normal (registering), inscripción tardía y
// re-entry (running con la ventana de late-reg abierta).
async function register(req, res) {
  const tid = req.params.id, pid = req.player.id;
  try {
    const [[t]] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [tid]);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });

    if (t.status === 'running') {
      if (!isLateRegOpen(tid)) return res.status(400).json({ error: 'La inscripción tardía ya cerró' });
      const [[reg]] = await pool.query(
        'SELECT final_position FROM tournament_registrations WHERE tournament_id = ? AND player_id = ?', [tid, pid]
      );
      if (reg && reg.final_position === null) return res.status(400).json({ error: 'Ya estás jugando este torneo' });
      const reentry = !!reg; // inscrito y eliminado → re-entry
      const buyIn = await chargeLateEntry(t, pid, reentry);
      const tableId = lateJoin(tid, pid, req.player.nickname, {
        reentry,
        addPrize: Math.max(0, buyIn - (parseFloat(t.bounty) || 0)),
      });
      if (!tableId) {
        // Sin asiento libre → reembolso completo (con rastro de auditoría)
        await pool.query('UPDATE players SET play_chips = play_chips + ? WHERE id = ?', [buyIn, pid]);
        const poolAdd = Math.max(0, buyIn - (parseFloat(t.bounty) || 0));
        await pool.query('UPDATE tournaments SET prize_pool = prize_pool - ? WHERE id = ?', [poolAdd, tid]);
        // (delta positivo con el mismo reason = reversa del cobro)
        await pool.query(
          `INSERT INTO chip_transactions (player_id, chip_mode, delta, reason, reference_id) VALUES (?, 'play', ?, 'tournament_buyin', ?)`,
          [pid, buyIn, tid]
        );
        if (!reentry) await pool.query('DELETE FROM tournament_registrations WHERE tournament_id = ? AND player_id = ?', [tid, pid]);
        return res.status(400).json({ error: 'No hay asientos libres ahora mismo' });
      }
      return res.json({ ok: true, late: true, reentry, tableId });
    }

    const r = await registerPlayer(tid, pid);
    // Auto-arranque al llenarse
    if (r.newCount >= r.max) startTournament(tid).catch(e => console.error('[torneo autostart]', e.message));
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.msg });
    console.error('[register]', e); res.status(500).json({ error: 'Error al inscribir' });
  }
}

// POST /tournaments/:id/unregister
async function unregister(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[t]] = await conn.query('SELECT * FROM tournaments WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!t || t.status !== 'registering') { await conn.rollback(); return res.status(400).json({ error: 'No se puede cancelar' }); }
    const [del] = await conn.query('DELETE FROM tournament_registrations WHERE tournament_id = ? AND player_id = ?', [req.params.id, req.player.id]);
    if (del.affectedRows) {
      const buyIn = parseFloat(t.buy_in) || 0;
      await conn.query('UPDATE players SET play_chips = play_chips + ? WHERE id = ?', [buyIn, req.player.id]);
      await conn.query('UPDATE tournaments SET prize_pool = GREATEST(prize_pool - ?, 0) WHERE id = ?', [buyIn, req.params.id]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback(); res.status(500).json({ error: 'Error' });
  } finally {
    conn.release();
  }
}

// POST /tournaments/:id/bots  (admin) → rellenar con N bots de un nivel
async function fillBots(req, res) {
  const { level, count = 1 } = req.body;
  if (![5, 6, 7, 8, 9, 10].includes(Number(level))) return res.status(400).json({ error: 'Nivel 5-10' });
  const [[t]] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
  if (!t || t.status !== 'registering') return res.status(400).json({ error: 'Inscripciones cerradas' });
  const [[cnt]] = await pool.query('SELECT COUNT(*) n FROM tournament_registrations WHERE tournament_id = ?', [req.params.id]);
  const room = t.max_players - cnt.n;
  const n = Math.min(Number(count) || 1, room);
  if (n <= 0) return res.status(400).json({ error: 'Torneo lleno' });
  const [bots] = await pool.query(
    `SELECT b.bot_id FROM bots b
     WHERE b.level = ? AND b.bot_id NOT IN (SELECT player_id FROM tournament_registrations WHERE tournament_id = ?)
     ORDER BY RAND() LIMIT ?`,
    [Number(level), req.params.id, n]
  );
  let added = 0;
  for (const b of bots) {
    try { await registerPlayer(req.params.id, b.bot_id); added++; } catch {}
  }
  // Si con esto se llenó el cupo, arranca solo
  if (cnt.n + added >= t.max_players) {
    startTournament(req.params.id).catch(e => console.error('[torneo autostart bots]', e.message));
  }
  res.json({ added, started: cnt.n + added >= t.max_players });
}

// POST /tournaments/:id/start  (admin) → forzar inicio
async function start(req, res) {
  try {
    const r = await startTournament(req.params.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// GET /tournaments/:id/my-table  → mesa actual del jugador (para (re)entrar)
async function myTable(req, res) {
  const tableId = getPlayerTable(req.params.id, req.player.id);
  if (!tableId) return res.status(404).json({ error: 'No estás en una mesa activa de este torneo' });
  res.json({ tableId });
}

// GET /tournaments/:id/standings  → clasificación (vivos + eliminados)
function standings(req, res) {
  const data = getStandings(req.params.id);
  if (!data) return res.status(404).json({ error: 'Torneo no activo' });
  res.json(data);
}

module.exports = { listTournaments, getTournament, createTournament, register, unregister, fillBots, start, myTable, standings, initScheduler };
