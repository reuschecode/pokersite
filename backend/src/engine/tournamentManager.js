'use strict';

// Torneos multi-mesa (MTT). Ciclo: registering → running → finished.
// - Reparte a los inscritos en mesas de hasta 6 (varias mesas en paralelo).
// - Reutiliza el motor server-autoritativo (cada mesa juega como una cash normal).
// - Ciegas GLOBALES (un temporizador actualiza todas las mesas).
// - Posiciones y premios GLOBALES sobre todo el campo.
// - Rebalanceo: mueve jugadores, rompe mesas al reducirse el campo, y arma la
//   mesa final cuando quedan ≤6.

const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const tm = require('./tableManager');
const { startHand, emitToTable, emitToPlayer } = require('./gameStateMachine');
const { BotClient } = require('./bot/BotClient');

const STARTING_STACK = 1500;
const TABLE_SIZE = 6;

// Schedule por defecto (niveles de ciegas por minutos)
const DEFAULT_BLINDS = [
  { smallBlind: 10, bigBlind: 20, minutes: 3 },
  { smallBlind: 15, bigBlind: 30, minutes: 3 },
  { smallBlind: 25, bigBlind: 50, minutes: 3 },
  { smallBlind: 50, bigBlind: 100, minutes: 3, ante: 10 },
  { smallBlind: 100, bigBlind: 200, minutes: 3, ante: 25 },
  { smallBlind: 200, bigBlind: 400, minutes: 3, ante: 50 },
  { smallBlind: 400, bigBlind: 800, minutes: 3, ante: 100 },
  { smallBlind: 800, bigBlind: 1600, minutes: 99, ante: 200 },
];

// Runtime por torneo: tournamentId → { tableIds, botClients(Map), seatOf(Map),
//   blindTimer, blindIdx, schedule, remaining(Set), positions, prizePool, payout, chipMode }
const runtime = new Map();

function jparse(v, fallback) {
  try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch { return fallback; }
}

function defaultPayout(n) {
  if (n <= 3) return { 1: 1 };
  if (n <= 6) return { 1: 0.6, 2: 0.4 };
  if (n <= 12) return { 1: 0.5, 2: 0.3, 3: 0.2 };
  if (n <= 20) return { 1: 0.4, 2: 0.27, 3: 0.19, 4: 0.14 };
  return { 1: 0.35, 2: 0.24, 3: 0.18, 4: 0.13, 5: 0.10 };
}

// ── Arrancar un torneo (registering → running) ──
async function startTournament(tournamentId) {
  const [rows] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [tournamentId]);
  if (!rows.length) throw new Error('Torneo no encontrado');
  const t = rows[0];
  if (t.status !== 'registering') throw new Error('El torneo no está en inscripción');

  const [regs] = await pool.query(
    `SELECT r.player_id, p.nickname, p.is_bot, b.level, b.personality_json
     FROM tournament_registrations r
     JOIN players p ON p.id = r.player_id
     LEFT JOIN bots b ON b.bot_id = r.player_id
     WHERE r.tournament_id = ?`,
    [tournamentId]
  );
  if (regs.length < 2) throw new Error('Se necesitan al menos 2 inscritos');

  const schedule = jparse(t.blind_schedule_json, DEFAULT_BLINDS);
  const lvl0 = schedule[0] || DEFAULT_BLINDS[0];
  const numTables = Math.ceil(regs.length / TABLE_SIZE);

  // Orden mezclado estable (para repartir por mesas)
  const order = [...regs].sort((a, b) => hashInt(a.player_id) - hashInt(b.player_id));

  // Crear las mesas
  const tableIds = [];
  for (let i = 0; i < numTables; i++) {
    const id = uuidv4();
    tm.createTable({
      id, name: `${t.name} — Mesa ${i + 1}`, gameType: t.game_type, chipMode: t.chip_mode,
      maxSeats: TABLE_SIZE, smallBlind: lvl0.smallBlind, bigBlind: lvl0.bigBlind,
      buyInMin: STARTING_STACK, buyInMax: STARTING_STACK,
    });
    const table = tm.getTable(id);
    table.isTournament = true;
    table.tournamentId = tournamentId;
    table.tournamentOver = false;
    table.ante = lvl0.ante || 0;
    table.onBust = (busted, hunter) => onBust(tournamentId, busted, hunter);
    table.onHandComplete = () => onHandComplete(tournamentId, id);
    tableIds.push(id);
  }

  // Repartir jugadores round-robin y sentarlos con stack igual
  const seatOf = new Map();
  order.forEach((r, idx) => {
    const tid = tableIds[idx % numTables];
    tm.seatPlayer(tm.getTable(tid), r.player_id, r.nickname, STARTING_STACK);
    seatOf.set(r.player_id, tid);
  });

  // Conectar los bots a SU mesa (join_table cae en el camino idempotente)
  const botClients = new Map();
  order.filter(x => x.is_bot).forEach((r, i) => {
    setTimeout(() => {
      const client = new BotClient({
        botId: r.player_id, nickname: r.nickname, level: r.level || 5,
        personality: jparse(r.personality_json, {}), tableId: seatOf.get(r.player_id), buyIn: STARTING_STACK,
      });
      botClients.set(r.player_id, client);
    }, i * 120); // escalonar conexiones
  });

  // Avisar a los humanos: cada uno a su mesa
  for (const r of order.filter(x => !x.is_bot)) {
    emitToPlayer(r.player_id, 'torneo_iniciado', { tournamentId, tableId: seatOf.get(r.player_id) });
  }

  const rt = {
    tableIds, botClients, seatOf, blindTimer: null, blindIdx: 0, schedule,
    remaining: new Set(order.map(r => r.player_id)),
    positions: {},
    prizePool: parseFloat(t.prize_pool) || 0,
    payout: jparse(t.payout_json, defaultPayout(regs.length)),
    chipMode: t.chip_mode,
    totalEntrants: regs.length,
    name: t.name,
    id: tournamentId,
    bounty: parseFloat(t.bounty) || 0,
    nicks: Object.fromEntries(regs.map(r => [r.player_id, r.nickname])),
  };
  runtime.set(tournamentId, rt);
  updateTournamentInfo(rt);
  snapshotTournament(tournamentId); // snapshot inicial (por si se reinicia enseguida)

  await pool.query('UPDATE tournaments SET status = "running", started_at = NOW() WHERE id = ?', [tournamentId]);
  for (const tid of tableIds) {
    emitToTable(tid, 'chat_received', {
      playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
      text: `¡Comienza ${t.name}! ${regs.length} jugadores en ${numTables} mesa(s). Ciegas ${lvl0.smallBlind}/${lvl0.bigBlind}.`,
    });
  }

  // Ciegas globales + primera mano por mesa (escalonadas)
  scheduleBlindIncrease(tournamentId);
  tableIds.forEach((tid, i) => {
    setTimeout(() => {
      try { startHand(tm.getTable(tid)); }
      catch (e) { console.error('[torneo] ERROR startHand:', e.message); }
    }, 3000 + i * 500);
  });

  return { tableIds };
}

function hashInt(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Persistencia: snapshot del runtime en DB (sobrevive a reinicios) ──
// Se guarda al terminar cada mano (punto limpio: stacks sin apuestas en vuelo).
function snapshotTournament(tournamentId) {
  const rt = runtime.get(tournamentId);
  if (!rt) return;
  try {
    const tables = rt.tableIds.map(tid => {
      const tb = tm.getTable(tid);
      if (!tb) return null;
      return {
        id: tb.id,
        name: tb.name,
        seats: tb.seats
          .filter(s => s.playerId && rt.remaining.has(s.playerId))
          .map(s => ({ playerId: s.playerId, nickname: s.nickname, stack: s.stack })),
      };
    }).filter(Boolean);
    const snap = {
      blindIdx: rt.blindIdx,
      schedule: rt.schedule,
      bounty: rt.bounty || 0,
      name: rt.name,
      chipMode: rt.chipMode,
      prizePool: rt.prizePool,
      payout: rt.payout,
      totalEntrants: rt.totalEntrants,
      nicks: rt.nicks,
      positions: rt.positions,
      remaining: [...rt.remaining],
      seatOf: Object.fromEntries(rt.seatOf),
      tables,
    };
    // Fire-and-forget: no bloquear el juego por la escritura
    pool.query('UPDATE tournaments SET runtime_json = ? WHERE id = ?', [JSON.stringify(snap), tournamentId])
      .catch(e => console.error('[torneo snapshot]', e.message));
  } catch (e) {
    console.error('[torneo snapshot]', e.message);
  }
}

// Rehidratar torneos 'running' tras un reinicio del servidor: recrea mesas con
// los stacks guardados, re-sienta bots y reanuda ciegas. Los humanos vuelven
// vía my-table / torneo_iniciado. Torneos running SIN snapshot (fantasmas
// antiguos) se cierran para limpiar el lobby.
async function resumeTournaments() {
  const [rows] = await pool.query("SELECT * FROM tournaments WHERE status = 'running'");
  for (const t of rows) {
    const snap = jparse(t.runtime_json, null);
    if (!snap || !snap.tables?.length || !snap.remaining?.length) {
      await pool.query("UPDATE tournaments SET status = 'finished', ended_at = NOW() WHERE id = ?", [t.id]);
      console.log(`[Torneos] "${t.name}" sin snapshot — marcado como finalizado`);
      continue;
    }
    try {
      const schedule = snap.schedule || jparse(t.blind_schedule_json, DEFAULT_BLINDS);
      const blindIdx = Math.min(snap.blindIdx || 0, schedule.length - 1);
      const lvl = schedule[blindIdx];

      // Recrear cada mesa con sus jugadores y stacks
      for (const tSnap of snap.tables) {
        tm.createTable({
          id: tSnap.id, name: tSnap.name, gameType: t.game_type, chipMode: t.chip_mode,
          maxSeats: TABLE_SIZE, smallBlind: lvl.smallBlind, bigBlind: lvl.bigBlind,
          buyInMin: STARTING_STACK, buyInMax: STARTING_STACK,
        });
        const table = tm.getTable(tSnap.id);
        table.isTournament = true;
        table.tournamentId = t.id;
        table.tournamentOver = false;
        table.ante = lvl.ante || 0;
        table.onBust = (busted, hunter) => onBust(t.id, busted, hunter);
        table.onHandComplete = () => onHandComplete(t.id, tSnap.id);
        for (const s of tSnap.seats) {
          tm.seatPlayer(table, s.playerId, s.nickname, s.stack);
        }
      }

      const rt = {
        tableIds: snap.tables.map(x => x.id),
        botClients: new Map(),
        seatOf: new Map(Object.entries(snap.seatOf || {})),
        blindTimer: null,
        blindIdx,
        schedule,
        remaining: new Set(snap.remaining),
        positions: snap.positions || {},
        prizePool: snap.prizePool || parseFloat(t.prize_pool) || 0,
        payout: snap.payout || jparse(t.payout_json, defaultPayout(snap.totalEntrants || 6)),
        chipMode: snap.chipMode || t.chip_mode,
        totalEntrants: snap.totalEntrants || snap.remaining.length,
        name: snap.name || t.name,
        id: t.id,
        bounty: snap.bounty || parseFloat(t.bounty) || 0,
        nicks: snap.nicks || {},
      };
      runtime.set(t.id, rt);
      updateTournamentInfo(rt);

      // Reconectar los bots vivos (con su nivel/personalidad reales)
      const ids = [...rt.remaining];
      const [bots] = await pool.query(
        `SELECT b.bot_id, b.level, b.personality_json, p.nickname
         FROM bots b JOIN players p ON p.id = b.bot_id
         WHERE b.bot_id IN (${ids.map(() => '?').join(',')})`, ids
      );
      bots.forEach((r, i) => {
        setTimeout(() => {
          const client = new BotClient({
            botId: r.bot_id, nickname: r.nickname, level: r.level || 5,
            personality: jparse(r.personality_json, {}),
            tableId: rt.seatOf.get(r.bot_id), buyIn: STARTING_STACK,
          });
          rt.botClients.set(r.bot_id, client);
        }, i * 120);
      });

      // Avisar a los humanos conectados dónde está su mesa
      for (const pid of rt.remaining) {
        if (!bots.some(b => b.bot_id === pid)) {
          emitToPlayer(pid, 'torneo_iniciado', { tournamentId: t.id, tableId: rt.seatOf.get(pid) });
        }
      }

      // Reanudar ciegas y manos (tras dar tiempo a que conecten los bots)
      scheduleBlindIncrease(t.id);
      rt.tableIds.forEach((tid, i) => {
        setTimeout(() => {
          try { startHand(tm.getTable(tid)); }
          catch (e) { console.error('[torneo resume] startHand:', e.message); }
        }, 4000 + i * 500);
      });

      console.log(`[Torneos] "${rt.name}" restaurado: ${rt.remaining.size} vivos en ${rt.tableIds.length} mesa(s)`);
    } catch (e) {
      console.error(`[Torneos] no se pudo restaurar "${t.name}":`, e.message);
    }
  }
}

// Arma la info del torneo para el HUD y la pega en cada mesa viva.
function updateTournamentInfo(rt) {
  if (!rt) return;
  const lvl = rt.schedule[Math.min(rt.blindIdx, rt.schedule.length - 1)] || {};
  const info = {
    tournamentId: rt.id || null,
    name: rt.name || null,
    remaining: rt.remaining.size,
    total: rt.totalEntrants,
    level: rt.blindIdx + 1,
    smallBlind: lvl.smallBlind,
    bigBlind: lvl.bigBlind,
    ante: lvl.ante || 0,
    paidPlaces: Object.keys(rt.payout || {}).length,
  };
  for (const tid of rt.tableIds) {
    const tb = tm.getTable(tid);
    if (tb) tb.tournamentInfo = info;
  }
}

// ── Helpers de mesas vivas ──
function tablePlayers(rt, table) {
  return table.seats.filter(s => s.playerId && rt.remaining.has(s.playerId)).map(s => s.playerId);
}
function aliveTables(rt) {
  return rt.tableIds
    .map(id => tm.getTable(id)).filter(Boolean)
    .map(table => ({ id: table.id, table, players: tablePlayers(rt, table) }))
    .filter(t => t.players.length > 0);
}
// Índice de un asiento libre: vacío, o de un jugador ya eliminado (aún no removido)
function freeSeatIndex(rt, table) {
  let idx = table.seats.findIndex(s => !s.playerId || s.status === 'empty');
  if (idx >= 0) return idx;
  return table.seats.findIndex(s => s.playerId && !rt.remaining.has(s.playerId));
}
function removeTournamentTable(rt, id) {
  const table = tm.getTable(id);
  if (table) table.tournamentOver = true;
  rt.tableIds = rt.tableIds.filter(t => t !== id);
  tm.removeTable(id);
}

// ── Mover un jugador de una mesa a otra ──
function movePlayer(rt, pid, fromTable, toTable) {
  const idx = freeSeatIndex(rt, toTable);
  if (idx < 0) return false; // sin sitio
  const from = fromTable.seats.find(s => s.playerId === pid);
  const nick = from ? from.nickname : '?';
  const stack = tm.standPlayer(fromTable, pid) || 0;
  const seat = toTable.seats[idx];
  seat.playerId = pid; seat.nickname = nick; seat.stack = stack; seat.cards = [];
  seat.status = toTable.phase !== 'waiting' ? 'sitting_out' : 'active';
  rt.seatOf.set(pid, toTable.id);
  const bot = rt.botClients.get(pid);
  if (bot) bot.switchTable(toTable.id);
  else emitToPlayer(pid, 'torneo_mesa_cambiada', { tableId: toTable.id });
  emitToTable(toTable.id, 'chat_received', {
    playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
    text: `${nick} se sienta desde otra mesa`,
  });
  return true;
}

// ── Rebalanceo tras cada mano ──
function rebalance(rt) {
  let tables = aliveTables(rt);
  if (tables.length <= 1) return;

  const target = Math.max(1, Math.ceil(rt.remaining.size / TABLE_SIZE));

  // 1) Romper mesas hasta llegar al objetivo (rompe la más pequeña que esté en 'waiting')
  let guard = 0;
  while (aliveTables(rt).length > target && guard++ < 12) {
    const sorted = aliveTables(rt).sort((a, b) => a.players.length - b.players.length);
    const src = sorted.find(t => t.table.phase === 'waiting');
    if (!src) break; // ninguna rompible ahora; se hará al completar su mano
    let ok = true;
    for (const pid of [...src.players]) {
      const dest = aliveTables(rt)
        .filter(t => t.id !== src.id && freeSeatIndex(rt, t.table) >= 0)
        .sort((a, b) => a.players.length - b.players.length)[0];
      if (!dest) { ok = false; break; }
      movePlayer(rt, pid, src.table, dest.table);
    }
    if (tablePlayers(rt, src.table).length === 0) removeTournamentTable(rt, src.id);
    if (!ok) break;
  }

  // 2) Igualar: mover 1 de la mesa más llena (en 'waiting') a la más vacía
  const alive = aliveTables(rt);
  if (alive.length > 1) {
    const sorted = [...alive].sort((a, b) => a.players.length - b.players.length);
    const min = sorted[0], max = sorted[sorted.length - 1];
    if (max.players.length - min.players.length >= 2 && max.table.phase === 'waiting'
        && freeSeatIndex(rt, min.table) >= 0) {
      movePlayer(rt, max.players[0], max.table, min.table);
    }
  }
}

// ── Subida de ciegas global ──
function scheduleBlindIncrease(tournamentId) {
  const rt = runtime.get(tournamentId);
  if (!rt) return;
  const cur = rt.schedule[rt.blindIdx] || rt.schedule[rt.schedule.length - 1];
  const mins = cur.minutes || 3;
  rt.blindTimer = setTimeout(() => {
    const rt2 = runtime.get(tournamentId);
    if (!rt2) return;
    rt2.blindIdx = Math.min(rt2.blindIdx + 1, rt2.schedule.length - 1);
    const lvl = rt2.schedule[rt2.blindIdx];
    for (const tid of rt2.tableIds) {
      const table = tm.getTable(tid);
      if (table && !table.tournamentOver) {
        table.smallBlind = lvl.smallBlind;
        table.bigBlind = lvl.bigBlind;
        table.ante = lvl.ante || 0;
        emitToTable(tid, 'chat_received', {
          playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
          text: `⏫ Ciegas: ${lvl.smallBlind}/${lvl.bigBlind}${lvl.ante ? ` (ante ${lvl.ante})` : ''}`,
        });
      }
    }
    updateTournamentInfo(rt2);
    scheduleBlindIncrease(tournamentId);
  }, mins * 60 * 1000);
}

// ── Eliminaciones (global) ──
function onBust(tournamentId, bustedList, hunter = null) {
  const rt = runtime.get(tournamentId);
  if (!rt) return;
  let bountiesWon = 0;
  for (const b of bustedList) {
    if (!rt.remaining.has(b.playerId)) continue;
    rt.remaining.delete(b.playerId);
    const pos = rt.remaining.size + 1;
    rt.positions[b.playerId] = pos;
    if (rt.bounty > 0 && hunter && hunter.playerId !== b.playerId) bountiesWon++;
    for (const tid of rt.tableIds) {
      emitToTable(tid, 'chat_received', {
        playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
        text: `💀 ${b.nickname} eliminado — puesto ${pos} (quedan ${rt.remaining.size})`,
      });
    }
  }
  // Bounty/KO: el cazador cobra la recompensa por cada cabeza (al instante)
  if (bountiesWon > 0) {
    const total = Math.round(rt.bounty * bountiesWon);
    const chipCol = rt.chipMode === 'real' ? 'real_chips' : 'play_chips';
    pool.query(`UPDATE players SET ${chipCol} = ${chipCol} + ? WHERE id = ?`, [total, hunter.playerId])
      .then(() => pool.query(
        `INSERT INTO chip_transactions (player_id, chip_mode, delta, reason, reference_id) VALUES (?, ?, ?, 'tournament_prize', ?)`,
        [hunter.playerId, rt.chipMode, total, tournamentId]
      ))
      .catch(e => console.error('[torneo bounty]', e.message));
    emitToPlayer(hunter.playerId, 'chips_updated', { chipMode: rt.chipMode, amount: total });
    for (const tid of rt.tableIds) {
      emitToTable(tid, 'chat_received', {
        playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
        text: `🎯 ${hunter.nickname} cobra ${bountiesWon > 1 ? `${bountiesWon} recompensas` : 'la recompensa'} (+${total})`,
      });
    }
  }
  updateTournamentInfo(rt);
}

// ── Al completar una mano en una mesa ──
async function onHandComplete(tournamentId, completedTableId) {
  const rt = runtime.get(tournamentId);
  if (!rt) return;

  // ¿Ganador? (1 jugador vivo en todo el campo). Se resuelve SINCRÓNICAMENTE
  // (marcar tournamentOver antes de cualquier await) para que el motor no
  // agende otra mano.
  if (rt.remaining.size <= 1) {
    const winnerId = [...rt.remaining][0];
    if (winnerId) rt.positions[winnerId] = 1;
    for (const tid of rt.tableIds) { const tb = tm.getTable(tid); if (tb) tb.tournamentOver = true; }
    if (rt.blindTimer) clearTimeout(rt.blindTimer);
    await finalize(tournamentId);
    return;
  }

  // Si no hay ganador, rebalancear (sincrónico) y guardar snapshot (punto limpio)
  try { rebalance(rt); } catch (e) { console.error('[torneo] rebalance:', e.message); }
  snapshotTournament(tournamentId);
}

// ── Pagos y cierre ──
async function finalize(tournamentId) {
  const rt = runtime.get(tournamentId);
  if (!rt) return;
  const chipCol = rt.chipMode === 'real' ? 'real_chips' : 'play_chips';
  const [[tRow]] = await pool.query('SELECT name FROM tournaments WHERE id = ?', [tournamentId]);

  for (const [playerId, position] of Object.entries(rt.positions)) {
    const frac = rt.payout[position] || 0;
    // Bounty: el campeón cobra también su propia recompensa (estilo KO)
    const ownBounty = (Number(position) === 1 && rt.bounty > 0) ? Math.round(rt.bounty) : 0;
    const prize = Math.round(rt.prizePool * frac) + ownBounty;
    await pool.query(
      'UPDATE tournament_registrations SET final_position = ?, prize_won = ? WHERE tournament_id = ? AND player_id = ?',
      [position, prize, tournamentId, playerId]
    );
    if (prize > 0) {
      await pool.query(`UPDATE players SET ${chipCol} = ${chipCol} + ? WHERE id = ?`, [prize, playerId]);
      await pool.query(
        `INSERT INTO chip_transactions (player_id, chip_mode, delta, reason, reference_id) VALUES (?, ?, ?, 'tournament_prize', ?)`,
        [playerId, rt.chipMode, prize, tournamentId]
      );
    }
  }

  await pool.query('UPDATE tournaments SET status = "finished", ended_at = NOW(), runtime_json = NULL WHERE id = ?', [tournamentId]);
  for (const tid of rt.tableIds) {
    emitToTable(tid, 'torneo_finalizado', { tournamentId, name: tRow?.name, positions: rt.positions });
  }

  // Limpiar tras la celebración
  setTimeout(() => {
    for (const c of rt.botClients.values()) { try { c.leave(); } catch {} }
    for (const tid of rt.tableIds) tm.removeTable(tid);
    runtime.delete(tournamentId);
  }, 8000);
}

// Mesa actual de un jugador en un torneo en curso (para (re)entrar si se perdió
// el evento torneo_iniciado). Devuelve el tableId o null.
function getPlayerTable(tournamentId, playerId) {
  const rt = runtime.get(tournamentId);
  return rt?.seatOf?.get(playerId) || null;
}

// ── Inscripción tardía y re-entry ──
const LATE_REG_LEVELS = 3; // se puede entrar/volver hasta antes del nivel 4 de ciegas

function isLateRegOpen(tournamentId) {
  const rt = runtime.get(tournamentId);
  return !!rt && rt.blindIdx < LATE_REG_LEVELS && rt.remaining.size >= 1;
}

// Sienta a un jugador que entra tarde (inscripción tardía o re-entry) en la
// mesa viva con más asientos libres. Devuelve el tableId o null si no hay sitio.
// El cobro del buy-in lo hace el controller; aquí solo el estado del torneo.
function lateJoin(tournamentId, playerId, nickname, { reentry = false, addPrize = 0 } = {}) {
  const rt = runtime.get(tournamentId);
  if (!rt || !isLateRegOpen(tournamentId)) return null;
  const candidates = aliveTables(rt)
    .filter(t => t.table.seats.some(s => !s.playerId || s.status === 'empty'))
    .sort((a, b) => a.players.length - b.players.length);
  const target = candidates[0];
  if (!target) return null;
  const seat = tm.seatPlayer(target.table, playerId, nickname, STARTING_STACK);
  if (!seat) return null;
  // Si la mesa está en medio de una mano, espera a la siguiente
  if (target.table.phase !== 'waiting') seat.status = 'sitting_out';
  rt.remaining.add(playerId);
  rt.nicks[playerId] = nickname;
  rt.seatOf.set(playerId, target.id);
  if (reentry) delete rt.positions[playerId];
  else rt.totalEntrants += 1;
  if (addPrize) rt.prizePool += addPrize;
  updateTournamentInfo(rt);
  snapshotTournament(tournamentId);
  emitToPlayer(playerId, 'torneo_iniciado', { tournamentId, tableId: target.id });
  emitToTable(target.id, 'chat_received', {
    playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
    text: reentry ? `🔄 ${nickname} re-entra al torneo` : `🆕 ${nickname} se une al torneo (inscripción tardía)`,
  });
  return target.id;
}

// Clasificación tipo PokerStars: jugadores vivos (con fichas, ordenados de más
// a menos) y eliminados (con su puesto). No expone nivel de bot.
function getStandings(tournamentId) {
  const rt = runtime.get(tournamentId);
  if (!rt) return null;
  const alive = [];
  rt.tableIds.forEach((tid, ti) => {
    const tb = tm.getTable(tid);
    if (!tb) return;
    for (const s of tb.seats) {
      if (s.playerId && rt.remaining.has(s.playerId)) {
        alive.push({ playerId: s.playerId, nickname: s.nickname || rt.nicks?.[s.playerId] || '—', stack: s.stack || 0, table: ti + 1 });
      }
    }
  });
  alive.sort((a, b) => b.stack - a.stack).forEach((p, i) => { p.rank = i + 1; });
  const eliminated = Object.entries(rt.positions || {})
    .map(([pid, pos]) => ({ playerId: pid, nickname: rt.nicks?.[pid] || '—', position: pos }))
    .sort((a, b) => a.position - b.position);
  // Premio en fichas de cada puesto pagado (% del prize pool)
  const prizePool = rt.prizePool || 0;
  const payouts = {};
  Object.entries(rt.payout || {}).forEach(([pos, pct]) => { payouts[pos] = Math.round(prizePool * pct); });
  return {
    name: rt.name, total: rt.totalEntrants,
    paidPlaces: Object.keys(rt.payout || {}).length,
    prizePool, payouts, tables: rt.tableIds.length,
    alive, eliminated,
  };
}

module.exports = { startTournament, STARTING_STACK, DEFAULT_BLINDS, defaultPayout, getPlayerTable, getStandings, resumeTournaments, isLateRegOpen, lateJoin };
