'use strict';

const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

async function getMe(req, res) {
  const [rows] = await pool.query(
    'SELECT id, nickname, email, play_chips, real_chips, avatar_config, country, created_at FROM players WHERE id = ?',
    [req.player.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}

async function getHistory(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const [rows] = await pool.query(
    `SELECT id, table_id, tournament_id, hand_number, game_type, chip_mode,
            pot_total, winners_json, started_at, ended_at
     FROM hand_history
     WHERE JSON_SEARCH(players_json, 'one', ?, NULL, '$[*].playerId') IS NOT NULL
     ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
    [req.player.id, limit, offset]
  );
  res.json(rows);
}

async function refill(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT play_chips FROM players WHERE id = ? FOR UPDATE', [req.player.id]);
    if (p.play_chips >= 100) {
      await conn.rollback();
      return res.status(400).json({ error: 'You have enough chips' });
    }
    await conn.query('UPDATE players SET play_chips = play_chips + 1000 WHERE id = ?', [req.player.id]);
    await conn.query(
      `INSERT INTO chip_transactions (player_id, chip_mode, delta, reason) VALUES (?, 'play', 1000, 'refill')`,
      [req.player.id]
    );
    await conn.commit();
    const [[updated]] = await conn.query('SELECT play_chips FROM players WHERE id = ?', [req.player.id]);
    res.json({ play_chips: updated.play_chips });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function updateAvatar(req, res) {
  const { avatarConfig } = req.body;
  if (!avatarConfig || typeof avatarConfig !== 'object') return res.status(400).json({ error: 'avatarConfig requerido' });
  const json = JSON.stringify(avatarConfig);
  // Límite para imágenes propias (base64): ~200KB
  if (json.length > 200000) return res.status(413).json({ error: 'La imagen es demasiado grande (máx ~200KB)' });
  await pool.query('UPDATE players SET avatar_config = ? WHERE id = ?', [json, req.player.id]);
  res.json({ ok: true });
}

// ── Estadísticas del jugador (a partir de su historial de manos) ──
async function getStats(req, res) {
  const pid = req.player.id;
  const [rows] = await pool.query(
    `SELECT actions_json, winners_json, ended_at
     FROM hand_history
     WHERE JSON_SEARCH(players_json, 'one', ?, NULL, '$[*].playerId') IS NOT NULL
     ORDER BY ended_at DESC LIMIT 500`,
    [pid]
  );
  const jp = v => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } };

  let wins = 0, totalWon = 0, totalInvested = 0, bestWin = 0;
  // Métricas pro: VPIP (puso dinero voluntario preflop), PFR (subió preflop),
  // AF (factor de agresión: subidas / pagos)
  let vpipHands = 0, pfrHands = 0, aggRaises = 0, aggCalls = 0;
  const byDay = new Map(); // 'YYYY-MM-DD' → { hands, net }

  for (const r of rows) {
    const winners = jp(r.winners_json);
    const actions = jp(r.actions_json);
    let won = 0, invested = 0;
    let vpip = false, pfr = false, preflop = true;
    for (const a of actions) {
      if (typeof a.action === 'string' && a.action.startsWith('street_')) { preflop = false; continue; }
      if (a.playerId !== pid) continue;
      if (a.action !== 'win' && Number(a.amount) > 0) invested += Number(a.amount);
      if (preflop && ['call', 'call_allin', 'raise', 'all_in'].includes(a.action)) vpip = true;
      if (preflop && ['raise', 'all_in'].includes(a.action)) pfr = true;
      if (['raise', 'all_in'].includes(a.action)) aggRaises++;
      if (['call', 'call_allin'].includes(a.action)) aggCalls++;
    }
    for (const w of winners) if (w.playerId === pid) won += Number(w.amount) || 0;
    if (vpip) vpipHands++;
    if (pfr) pfrHands++;
    if (won > 0) { wins++; totalWon += won; if (won > bestWin) bestWin = won; }
    totalInvested += invested;

    const day = new Date(r.ended_at).toISOString().slice(0, 10);
    const d = byDay.get(day) || { hands: 0, net: 0 };
    d.hands++;
    d.net += won - invested;
    byDay.set(day, d);
  }

  const series = [...byDay.entries()]
    .map(([date, d]) => ({ date, hands: d.hands, net: Math.round(d.net) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    totalHands: rows.length,
    wins,
    winRate: rows.length ? Math.round((wins / rows.length) * 100) : 0,
    totalWon: Math.round(totalWon),
    totalInvested: Math.round(totalInvested),
    net: Math.round(totalWon - totalInvested),
    bestWin: Math.round(bestWin),
    vpip: rows.length ? Math.round((vpipHands / rows.length) * 100) : 0,
    pfr: rows.length ? Math.round((pfrHands / rows.length) * 100) : 0,
    af: aggCalls > 0 ? Math.round((aggRaises / aggCalls) * 10) / 10 : (aggRaises > 0 ? 99 : 0),
    series,
  });
}

// ── Logros e insignias (calculados de los datos, sin tablas nuevas) ──
async function getAchievements(req, res) {
  const pid = req.player.id;
  const [rows] = await pool.query(
    `SELECT winners_json, pot_total FROM hand_history
     WHERE JSON_SEARCH(players_json, 'one', ?, NULL, '$[*].playerId') IS NOT NULL
     ORDER BY ended_at DESC LIMIT 2000`,
    [pid]
  );
  const jp = v => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } };
  let wins = 0, bestWin = 0;
  for (const r of rows) {
    for (const w of jp(r.winners_json)) {
      if (w.playerId === pid) { wins++; const a = Number(w.amount) || 0; if (a > bestWin) bestWin = a; break; }
    }
  }
  const hands = rows.length;
  const [[t]] = await pool.query(
    `SELECT SUM(final_position = 1) campeonatos, SUM(final_position <= 3) podios,
            SUM(prize_won > 0) premios, COUNT(*) torneos
     FROM tournament_registrations WHERE player_id = ? AND final_position IS NOT NULL`,
    [pid]
  );
  const A = (id, emoji, nombre, desc, logrado, progreso = null) => ({ id, emoji, nombre, desc, logrado: !!logrado, progreso });
  res.json([
    A('primera_mano', '🃏', 'Primera mano', 'Juega tu primera mano', hands >= 1, `${Math.min(hands, 1)}/1`),
    A('cien_manos', '💯', 'Centenario', 'Juega 100 manos', hands >= 100, `${Math.min(hands, 100)}/100`),
    A('mil_manos', '🎰', 'Veterano', 'Juega 1000 manos', hands >= 1000, `${Math.min(hands, 1000)}/1000`),
    A('primera_victoria', '🥇', 'Primera sangre', 'Gana tu primera mano', wins >= 1, `${Math.min(wins, 1)}/1`),
    A('diez_victorias', '🔥', 'En racha', 'Gana 10 manos', wins >= 10, `${Math.min(wins, 10)}/10`),
    A('cincuenta_victorias', '⚡', 'Tiburón', 'Gana 50 manos', wins >= 50, `${Math.min(wins, 50)}/50`),
    A('gran_bote', '💰', 'Gran bote', 'Gana un bote de 500+', bestWin >= 500, bestWin ? `mejor: ${Math.round(bestWin)}` : '0/500'),
    A('primer_torneo', '🎫', 'Torneista', 'Termina un torneo', (t.torneos || 0) >= 1, `${Math.min(t.torneos || 0, 1)}/1`),
    A('en_premios', '🏅', 'En premios', 'Cobra premio en un torneo', (t.premios || 0) >= 1, `${t.premios || 0} vez/veces`),
    A('podio', '🥉', 'Podio', 'Queda top 3 en un torneo', (t.podios || 0) >= 1, `${t.podios || 0} podios`),
    A('campeon', '🏆', 'Campeón', 'Gana un torneo', (t.campeonatos || 0) >= 1, `${t.campeonatos || 0} títulos`),
  ]);
}

// ── Etiquetas de testers (qué nivel le adivinan a cada jugador/bot) ──
async function saveLabel(req, res) {
  const { targetId, estimatedLevel, tag, note } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId requerido' });
  if (targetId === req.player.id) return res.status(400).json({ error: 'No puedes etiquetarte a ti mismo' });
  const lvl = estimatedLevel === null || estimatedLevel === undefined ? null : Number(estimatedLevel);
  if (lvl !== null && (lvl < 1 || lvl > 10)) return res.status(400).json({ error: 'Nivel estimado 1-10' });
  await pool.query(
    `INSERT INTO tester_labels (tester_id, target_id, estimated_level, tag, note)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE estimated_level = VALUES(estimated_level), tag = VALUES(tag), note = VALUES(note)`,
    [req.player.id, targetId, lvl, tag || null, (note || '').slice(0, 200) || null]
  );
  res.json({ ok: true });
}

async function getLabels(req, res) {
  const [rows] = await pool.query(
    'SELECT target_id, estimated_level, tag, note FROM tester_labels WHERE tester_id = ?',
    [req.player.id]
  );
  // Mapa targetId -> { estimatedLevel, tag, note } para consumo directo en el cliente
  const map = {};
  for (const r of rows) map[r.target_id] = { estimatedLevel: r.estimated_level, tag: r.tag, note: r.note };
  res.json(map);
}

module.exports = { getMe, getHistory, refill, updateAvatar, saveLabel, getLabels, getStats, getAchievements };
