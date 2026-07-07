'use strict';

const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const tm = require('../engine/tableManager');
const { publicTableState } = require('../engine/gameStateMachine');

async function listTables(req, res) {
  const { game_type, chip_mode, status = 'waiting' } = req.query;
  // Las mesas privadas (con código) no aparecen en el lobby
  let query = 'SELECT * FROM tables_cash WHERE invite_code IS NULL';
  const params = [];
  if (game_type) { query += ' AND game_type = ?'; params.push(game_type); }
  if (chip_mode) { query += ' AND chip_mode = ?'; params.push(chip_mode); }
  if (status !== 'all') { query += ' AND status != "closed"'; }
  query += ' ORDER BY created_at DESC LIMIT 50';
  const [rows] = await pool.query(query, params);

  // Enrich with live seat count
  const enriched = rows.map(t => {
    const live = tm.getTable(t.id);
    const seated = live ? live.seats.filter(s => s.status !== 'empty').length : 0;
    return { ...t, seated, maxSeats: t.max_seats };
  });
  res.json(enriched);
}

async function getTable(req, res) {
  const [rows] = await pool.query('SELECT * FROM tables_cash WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Table not found' });
  const live = tm.getTable(req.params.id);
  const state = live ? publicTableState(live) : null;
  res.json({ ...rows[0], liveState: state });
}

async function createTable(req, res) {
  const { name, gameType = 'holdem', chipMode = 'play', maxSeats = 6, smallBlind = 5, bigBlind = 10, buyInMin = 100, buyInMax = 1000 } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  if (!['holdem', 'omaha', 'five_card_draw', 'seven_card_stud'].includes(gameType)) {
    return res.status(400).json({ error: 'Tipo de juego inválido' });
  }
  if (!['play', 'real'].includes(chipMode)) return res.status(400).json({ error: 'Modo de fichas inválido' });
  if (![2, 4, 6, 9].includes(Number(maxSeats))) return res.status(400).json({ error: 'Asientos: 2, 4, 6 o 9' });
  if (smallBlind <= 0 || bigBlind <= 0 || smallBlind > bigBlind) {
    return res.status(400).json({ error: 'Ciegas inválidas' });
  }
  if (buyInMin <= 0 || buyInMax <= 0 || buyInMin > buyInMax || buyInMin < bigBlind * 2) {
    return res.status(400).json({ error: 'Buy-in inválido (mínimo 2x la ciega grande)' });
  }
  const id = uuidv4();
  await pool.query(
    `INSERT INTO tables_cash (id, name, game_type, chip_mode, max_seats, small_blind, big_blind, buy_in_min, buy_in_max)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, gameType, chipMode, maxSeats, smallBlind, bigBlind, buyInMin, buyInMax]
  );
  tm.createTable({ id, name, gameType, chipMode, maxSeats, smallBlind, bigBlind, buyInMin, buyInMax });
  res.status(201).json({ id, name, gameType, chipMode, maxSeats, smallBlind, bigBlind, buyInMin, buyInMax });
}

// ── Mesas privadas (home games): cualquier jugador crea la suya ──
const crypto = require('crypto');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres confusos (0/O, 1/I)

function genInviteCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return c;
}

// POST /tables/private  (cualquier jugador autenticado)
async function createPrivateTable(req, res) {
  const { name, smallBlind = 5, bigBlind = 10, maxSeats = 6 } = req.body;
  const tableName = (name || `Mesa de ${req.player.nickname}`).trim().slice(0, 40);
  const sb = Number(smallBlind), bb = Number(bigBlind);
  if (!(sb > 0) || !(bb > 0) || sb > bb || bb > 1000) return res.status(400).json({ error: 'Ciegas inválidas' });
  if (![2, 4, 6, 9].includes(Number(maxSeats))) return res.status(400).json({ error: 'Asientos: 2, 4, 6 o 9' });
  // Límite: una mesa privada abierta por jugador (evita spam)
  const [[mine]] = await pool.query(
    "SELECT COUNT(*) n FROM tables_cash WHERE owner_id = ? AND invite_code IS NOT NULL AND status != 'closed'", [req.player.id]
  );
  if (mine.n >= 1) return res.status(400).json({ error: 'Ya tienes una mesa privada abierta' });

  const id = uuidv4();
  const code = genInviteCode();
  const buyInMin = bb * 20, buyInMax = bb * 200;
  await pool.query(
    `INSERT INTO tables_cash (id, name, game_type, chip_mode, max_seats, small_blind, big_blind, buy_in_min, buy_in_max, invite_code, owner_id)
     VALUES (?, ?, 'holdem', 'play', ?, ?, ?, ?, ?, ?, ?)`,
    [id, tableName, maxSeats, sb, bb, buyInMin, buyInMax, code, req.player.id]
  );
  tm.createTable({ id, name: tableName, gameType: 'holdem', chipMode: 'play', maxSeats, smallBlind: sb, bigBlind: bb, buyInMin, buyInMax });
  res.status(201).json({ id, name: tableName, inviteCode: code, smallBlind: sb, bigBlind: bb, buyInMin, buyInMax });
}

// GET /tables/by-code/:code → id de la mesa para unirse
async function getByCode(req, res) {
  const code = String(req.params.code || '').trim().toUpperCase();
  const [rows] = await pool.query(
    "SELECT id, name, small_blind, big_blind, buy_in_min, buy_in_max FROM tables_cash WHERE invite_code = ? AND status != 'closed'", [code]
  );
  if (!rows.length) return res.status(404).json({ error: 'Código no válido' });
  res.json(rows[0]);
}

module.exports = { listTables, getTable, createTable, createPrivateTable, getByCode };
