'use strict';

const { createDeck, shuffle, deal } = require('./deck');
const PotManager = require('./potManager');
const { validateAction } = require('./actionValidator');
const HandLogger = require('./handLogger');
const { bestHand, compareHands } = require('./variants/holdem/handEvaluator');

const ACTION_TIMEOUT_MS = 30_000;
const TIME_BANK_SECONDS = 30; // banco de tiempo extra por jugador (una vez por mesa)
const PHASES = ['pre_flop', 'flop', 'turn', 'river', 'showdown'];

// io is injected at init time
let _io;
function setIo(io) { _io = io; }

function emitToTable(tableId, event, data) {
  if (_io) _io.to(`table:${tableId}`).emit(event, data);
}

function emitToPlayer(playerId, event, data) {
  if (_io) _io.to(`player:${playerId}`).emit(event, data);
}

// ──────────────────────────────────────────────
// Table state helpers
// ──────────────────────────────────────────────

function activeSeatsSorted(table) {
  return table.seats
    .filter(s => s.playerId && ['active', 'all_in'].includes(s.status))
    .sort((a, b) => a.position - b.position);
}

function canActSeats(table) {
  return table.seats.filter(s => s.playerId && s.status === 'active');
}

function nextPosition(table, fromPosition) {
  const seats = activeSeatsSorted(table);
  const idx = seats.findIndex(s => s.position === fromPosition);
  return seats[(idx + 1) % seats.length].position;
}

function positionAfterDealer(table, dealerPos, skip = 1) {
  // Only seats with a real player who can play — empty/ghost seats must never
  // enter the blind/action rotation
  const seats = table.seats
    .filter(s => s.playerId && ['active', 'all_in'].includes(s.status))
    .sort((a, b) => a.position - b.position);
  if (!seats.length) return null;
  let idx = seats.findIndex(s => s.position === dealerPos);
  if (idx === -1) idx = 0; // dealer seat vacated — start from first player
  for (let i = 0; i < skip; i++) idx = (idx + 1) % seats.length;
  return seats[idx].position;
}

function publicTableState(table) {
  return {
    id: table.id,
    name: table.name,
    gameType: table.gameType,
    chipMode: table.chipMode,
    phase: table.phase,
    handNumber: table.handNumber,
    pot: table.potManager ? table.potManager.totalPot() : 0,
    pots: table.potManager ? table.potManager.getPotsSnapshot() : [],
    currentBet: table.currentBet,
    lastRaiseSize: table.lastRaiseSize,
    dealerPosition: table.dealerPosition,
    actionPosition: table.actionPosition,
    actionDeadline: table.actionDeadline,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    community: table.community,
    seats: table.seats.map(s => ({
      position: s.position,
      playerId: s.playerId || null,
      nickname: s.nickname || null,
      avatarConfig: s.avatarConfig || null,
      stack: s.stack,
      status: s.status,
      cards: s.status !== 'empty' ? s.cards.map(() => null) : [], // hide cards
      currentStreetBet: table.streetBets ? (table.streetBets[s.playerId] || 0) : 0,
      isDealer: s.position === table.dealerPosition,
      isSB: s.position === table.sbPosition,
      isBB: s.position === table.bbPosition,
    })),
    // Info del torneo (si aplica) para el HUD: la actualiza el tournamentManager.
    tournament: table.tournamentInfo || null,
  };
}

// ──────────────────────────────────────────────
// Hand lifecycle
// ──────────────────────────────────────────────

function startHand(table) {
  // Mesa de torneo ya cerrada/rota: no arrancar más manos
  if (table.tournamentOver) return;
  // Anyone seated with chips plays the next hand (including players who
  // joined mid-hand and were waiting as sitting_out)
  const readySeats = table.seats.filter(s => s.playerId && s.status !== 'empty' && s.stack > 0);
  if (readySeats.length < 2) return;

  clearTimeout(table.actionTimeout);

  // Reset seat states — clean up ghost seats (no playerId) and reset players.
  // sitting_out players WITH chips were waiting for the next hand — deal them in.
  for (const s of table.seats) {
    if (!s.playerId && s.status !== 'empty') {
      // Ghost seat — force to empty
      s.status = 'empty';
      s.cards = [];
      s.stack = 0;
      s.nickname = null;
    } else if (s.playerId && s.status !== 'empty' && s.stack > 0) {
      s.status = 'active';
      s.cards = [];
    }
  }

  table.handNumber++;
  table.community = [];
  table.currentBet = 0;
  table.lastRaiseSize = table.bigBlind;
  table.streetBets = {};
  table._actedThisStreet = new Set();
  table._runout = false;
  table.potManager = new PotManager();
  table.handLogger = new HandLogger();
  table.phase = 'pre_flop';

  // Rotate dealer
  const activeSeats = table.seats.filter(s => s.playerId && s.status === 'active').sort((a, b) => a.position - b.position);
  if (!table.dealerPosition && table.dealerPosition !== 0) {
    table.dealerPosition = activeSeats[0].position;
  } else {
    table.dealerPosition = positionAfterDealer(table, table.dealerPosition, 1);
  }

  // Heads-up rule: dealer IS the small blind and acts first pre-flop
  const headsUp = activeSeats.length === 2;
  const sbPos = headsUp ? table.dealerPosition : positionAfterDealer(table, table.dealerPosition, 1);
  const bbPos = headsUp
    ? positionAfterDealer(table, table.dealerPosition, 1)
    : positionAfterDealer(table, table.dealerPosition, 2);
  table.sbPosition = sbPos;
  table.bbPosition = bbPos;

  const sbSeat = table.seats.find(s => s.position === sbPos);
  const bbSeat = table.seats.find(s => s.position === bbPos);

  // Antes (torneos, niveles altos): dinero muerto al bote de cada jugador vivo.
  // No cuenta como apuesta de calle (no entra a streetBets).
  const ante = table.ante || 0;
  if (ante > 0) {
    for (const s of activeSeats) {
      const a = Math.min(ante, s.stack);
      if (a <= 0) continue;
      s.stack -= a;
      table.potManager.addBet(s.playerId, a, s.stack === 0);
      if (s.stack === 0) s.status = 'all_in';
      table.handLogger.log(s.playerId, 'post_ante', a, table.potManager.totalPot());
    }
  }

  // Post blinds
  const sbAmount = Math.min(table.smallBlind, sbSeat.stack);
  const bbAmount = Math.min(table.bigBlind, bbSeat.stack);

  sbSeat.stack -= sbAmount;
  bbSeat.stack -= bbAmount;
  table.streetBets[sbSeat.playerId] = sbAmount;
  table.streetBets[bbSeat.playerId] = bbAmount;
  table.potManager.addBet(sbSeat.playerId, sbAmount, sbSeat.stack === 0);
  table.potManager.addBet(bbSeat.playerId, bbAmount, bbSeat.stack === 0);
  if (sbSeat.stack === 0) sbSeat.status = 'all_in';
  if (bbSeat.stack === 0) bbSeat.status = 'all_in';

  // Standard rule: even if BB is short-stacked, others must still call the FULL big blind
  table.currentBet = table.bigBlind;
  table.lastRaiseSize = table.bigBlind;
  table.bbPlayerId = bbSeat.playerId;
  table.bbHasOption = true;

  table.handLogger.log(sbSeat.playerId, 'post_sb', sbAmount, table.potManager.totalPot());
  table.handLogger.log(bbSeat.playerId, 'post_bb', bbAmount, table.potManager.totalPot());

  // Shuffle and deal
  const deck = shuffle(createDeck());
  table.deck = deck;
  for (const s of table.seats.filter(s => s.playerId && (s.status === 'active' || s.status === 'all_in'))) {
    s.cards = deal(deck, 2);
  }

  // Pre-flop action: heads-up → dealer/SB acts first; otherwise UTG (left of BB)
  table.actionPosition = headsUp
    ? table.dealerPosition
    : positionAfterDealer(table, table.dealerPosition, 3);

  emitToTable(table.id, 'table_state', publicTableState(table));

  // Send private hole cards
  for (const s of table.seats.filter(s => s.cards.length)) {
    emitToPlayer(s.playerId, 'cards_dealt', { holeCards: s.cards });
  }

  scheduleAction(table);
}

function scheduleAction(table) {
  clearTimeout(table.actionTimeout);

  // If at most one player can still act (everyone else is all-in) and that
  // player owes nothing, betting is over — run out the remaining streets
  // DRAMATICALLY: reveal the all-in hands, then deal one street every 2.5s.
  const canAct = canActSeats(table);
  if (canAct.length <= 1) {
    const owed = canAct.length === 1
      ? (table.currentBet || 0) - (table.streetBets[canAct[0].playerId] || 0)
      : 0;
    if (owed <= 0) {
      if (!table._runout) {
        table._runout = true;
        // All-in showdown: everyone still in the hand shows their cards
        const inHand = table.seats.filter(s => s.playerId && ['active', 'all_in'].includes(s.status) && s.cards?.length);
        for (const s of inHand) {
          emitToTable(table.id, 'cards_revealed', { playerId: s.playerId, nickname: s.nickname, cards: s.cards });
        }
        emitToTable(table.id, 'runout_started', {});
        emitToTable(table.id, 'chat_received', {
          playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
          text: '¡Todos all-in! Se revelan las cartas...',
        });
      }
      table.actionTimeout = setTimeout(() => endStreet(table), 2500);
      return;
    }
  }

  const seat = table.seats.find(s => s.position === table.actionPosition);
  if (!seat || seat.status !== 'active') {
    advanceAction(table);
    return;
  }

  table.actionDeadline = Date.now() + ACTION_TIMEOUT_MS;
  // Send authoritative amounts so the client never derives a stale "owed"
  const toCall = Math.max(0, (table.currentBet || 0) - (table.streetBets[seat.playerId] || 0));
  emitToTable(table.id, 'action_required', {
    playerId: seat.playerId,
    timeoutMs: ACTION_TIMEOUT_MS,
    deadline: table.actionDeadline,
    toCall,
    currentBet: table.currentBet || 0,
    minRaiseTo: (table.currentBet || 0) + (table.lastRaiseSize || table.bigBlind),
  });

  table.actionTimeout = setTimeout(() => {
    // Banco de tiempo: 30s extra por jugador (una vez por sesión de mesa).
    // Se consume entero al activarse; los bots nunca lo necesitan.
    table.timeBanks = table.timeBanks || {};
    const pid = seat.playerId;
    const bank = table.timeBanks[pid] !== undefined ? table.timeBanks[pid] : TIME_BANK_SECONDS;
    if (bank >= 3) {
      table.timeBanks[pid] = 0;
      table.actionDeadline = Date.now() + bank * 1000;
      const toCallNow = Math.max(0, (table.currentBet || 0) - (table.streetBets[pid] || 0));
      emitToTable(table.id, 'action_required', {
        playerId: pid,
        timeoutMs: bank * 1000,
        deadline: table.actionDeadline,
        toCall: toCallNow,
        currentBet: table.currentBet || 0,
        minRaiseTo: (table.currentBet || 0) + (table.lastRaiseSize || table.bigBlind),
        timeBank: true,
      });
      emitToTable(table.id, 'chat_received', {
        playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
        text: `⏳ ${seat.nickname} usa su banco de tiempo (+${bank}s)`,
      });
      table.actionTimeout = setTimeout(() => {
        const owed = (table.currentBet || 0) - (table.streetBets[pid] || 0);
        processAction(table, pid, owed === 0 ? { type: 'check' } : { type: 'fold' }, true);
      }, bank * 1000);
      return;
    }
    const owed = (table.currentBet || 0) - (table.streetBets[seat.playerId] || 0);
    const autoAction = owed === 0 ? { type: 'check' } : { type: 'fold' };
    processAction(table, seat.playerId, autoAction, true);
  }, ACTION_TIMEOUT_MS);
}

function processAction(table, playerId, action, isAuto = false) {
  const result = validateAction(table, playerId, action);
  if (!result.valid) {
    emitToPlayer(playerId, 'error', { code: 'INVALID_ACTION', message: result.reason });
    return;
  }

  const seat = table.seats.find(s => s.playerId === playerId);
  const { resolvedType, resolvedAmount, isAllIn } = result;

  // Track voluntary actions per street (blinds don't count)
  if (!table._actedThisStreet) table._actedThisStreet = new Set();
  table._actedThisStreet.add(playerId);

  switch (resolvedType) {
    case 'fold':
      seat.status = 'folded';
      table.handLogger.log(playerId, 'fold', 0, table.potManager.totalPot());
      break;

    case 'check':
      table.bbHasOption = false;
      table.handLogger.log(playerId, 'check', 0, table.potManager.totalPot());
      break;

    case 'call': {
      seat.stack -= resolvedAmount;
      table.streetBets[playerId] = (table.streetBets[playerId] || 0) + resolvedAmount;
      // ALWAYS register the bet in the pot manager (not just all-ins)
      table.potManager.addBet(playerId, resolvedAmount, !!isAllIn);
      if (isAllIn) seat.status = 'all_in';
      table.handLogger.log(playerId, isAllIn ? 'call_allin' : 'call', resolvedAmount, table.potManager.totalPot());
      break;
    }

    case 'raise':
    case 'all_in': {
      const prevBet = table.streetBets[playerId] || 0;
      const totalBet = prevBet + resolvedAmount;
      const raiseSize = totalBet - table.currentBet;
      seat.stack -= resolvedAmount;
      table.streetBets[playerId] = totalBet;
      // An all-in below the current bet is a call-for-less; don't lower currentBet
      if (totalBet > table.currentBet) table.currentBet = totalBet;

      if (raiseSize >= table.lastRaiseSize) {
        table.lastRaiseSize = raiseSize;
        // Full raise re-opens the action: everyone except the raiser must act again
        table._raisedBy = playerId;
        table._actedThisStreet = new Set([playerId]);
      }

      // ALWAYS register the bet in the pot manager
      table.potManager.addBet(playerId, resolvedAmount, !!isAllIn);
      if (isAllIn) seat.status = 'all_in';
      table.bbHasOption = false;
      table.handLogger.log(playerId, isAllIn ? 'all_in' : 'raise', resolvedAmount, table.potManager.totalPot());
      break;
    }
  }

  emitToTable(table.id, 'action_broadcast', {
    playerId,
    type: resolvedType,
    amount: resolvedAmount,
    isAllIn: !!isAllIn,
    pot: table.potManager.totalPot(),
    stack: seat.stack,
    streetBet: table.streetBets[playerId] || 0,
    currentBet: table.currentBet,
  });

  // Check if hand is over
  const stillActive = table.seats.filter(s => s.playerId && s.status === 'active');
  const stillInHand = table.seats.filter(s => s.playerId && ['active', 'all_in'].includes(s.status));

  if (stillInHand.length === 1) {
    // Everyone else folded — immediate win, no showdown
    endStreet(table, true);
    return;
  }
  if (stillActive.length === 0) {
    // Everyone remaining is all-in — end this street normally; the
    // dramatic run-out chain (scheduleAction guard) deals the rest
    endStreet(table);
    return;
  }

  advanceAction(table);
}

function advanceAction(table) {
  const canAct = canActSeats(table);
  if (!canAct.length) {
    endStreet(table);
    return;
  }

  // Find next player STRICTLY CLOCKWISE from actionPosition.
  // The previous actor may have folded (no longer in `seats`), so we can't
  // rely on findIndex of actionPosition — find the first position greater
  // than it instead (with wrap-around). This was the turn-skipping bug.
  const seats = activeSeatsSorted(table);
  let start = seats.findIndex(s => s.position > table.actionPosition);
  if (start === -1) start = 0; // wrap to lowest position

  for (let k = 0; k < seats.length; k++) {
    const next = seats[(start + k) % seats.length];

    if (next.status !== 'active') continue;

    // Street ends only when the next player owes nothing AND has already
    // voluntarily acted this street (posting a blind doesn't count)
    const owed = (table.currentBet || 0) - (table.streetBets[next.playerId] || 0);
    const isBbOption = table.bbHasOption && next.playerId === table.bbPlayerId;
    const hasActed = table._actedThisStreet?.has(next.playerId);
    if (owed === 0 && hasActed && !isBbOption) {
      endStreet(table);
      return;
    }

    table.actionPosition = next.position;
    scheduleAction(table);
    return;
  }

  endStreet(table);
}

function endStreet(table, earlyEnd = false) {
  clearTimeout(table.actionTimeout);

  // Collect bets into pots
  const activeIds = table.seats.filter(s => ['active', 'all_in'].includes(s.status)).map(s => s.playerId);
  table.potManager.collectStreetBets(activeIds);

  emitToTable(table.id, 'pot_updated', {
    pots: table.potManager.getPotsSnapshot(),
    pot: table.potManager.totalPot(),
    currentBet: 0,
  });

  const stillInHand = table.seats.filter(s => ['active', 'all_in'].includes(s.status));

  if (earlyEnd || stillInHand.length <= 1) {
    runShowdown(table, true);
    return;
  }

  // Advance phase
  const phaseIdx = PHASES.indexOf(table.phase);
  if (phaseIdx >= 3) {
    runShowdown(table);
    return;
  }

  table.phase = PHASES[phaseIdx + 1];
  table.currentBet = 0;
  table.lastRaiseSize = table.bigBlind;
  table.streetBets = {};
  table._raisedBy = null;
  table._actedThisStreet = new Set();

  // Deal community cards
  switch (table.phase) {
    case 'flop':
      table.community = deal(table.deck, 3);
      break;
    case 'turn':
    case 'river':
      table.community.push(...deal(table.deck, 1));
      break;
  }

  emitToTable(table.id, 'community_updated', { community: table.community, phase: table.phase });

  // Street marker for hand replays — records which cards arrived when
  table.handLogger?.log(null, `street_${table.phase}`, 0, table.potManager.totalPot(), {
    community: [...table.community],
  });

  // Reset action to left of dealer
  table.actionPosition = positionAfterDealer(table, table.dealerPosition, 1);
  // Skip to first active
  const active = activeSeatsSorted(table);
  const startIdx = active.findIndex(s => s.position >= table.actionPosition);
  table.actionPosition = active[startIdx >= 0 ? startIdx : 0].position;

  scheduleAction(table);
}

function runShowdown(table, earlyEnd = false) {
  clearTimeout(table.actionTimeout);
  table.actionTimeout = null;
  table.phase = 'showdown';

  const inHand = table.seats.filter(s => s.playerId && ['active', 'all_in'].includes(s.status));
  const folded = table.seats.filter(s => s.playerId && s.status === 'folded');

  let rankedPlayers;

  if (earlyEnd && inHand.length === 1) {
    // Only 1 player left — they win everything
    rankedPlayers = [{ playerId: inHand[0].playerId, hand: { rank: 99, tiebreakers: [] } }];
  } else {
    // Safety: if we somehow reached showdown with an incomplete board,
    // deal the remaining community cards so hands can be evaluated
    if (table.community.length < 5 && inHand.length > 1) {
      table.community.push(...deal(table.deck, 5 - table.community.length));
      emitToTable(table.id, 'community_updated', { community: table.community, phase: 'river' });
    }
    // Evaluate hands
    rankedPlayers = inHand
      .map(s => ({
        playerId: s.playerId,
        hand: bestHand([...s.cards, ...table.community]),
        cards: s.cards,
      }))
      .sort((a, b) => compareHands(b.hand, a.hand));
  }

  const awards = table.potManager.awardPots(rankedPlayers);

  // Apply awards
  const winners = [];
  for (const [playerId, amount] of Object.entries(awards)) {
    const seat = table.seats.find(s => s.playerId === playerId);
    if (seat) seat.stack += amount;
    const rp = rankedPlayers.find(p => p.playerId === playerId);
    winners.push({ playerId, nickname: seat?.nickname || '???', amount, handName: rp?.hand?.name || 'Winner', cards: rp?.cards || [] });
    table.handLogger.log(playerId, 'win', amount, 0);
  }

  // Persist hand
  const playersSnapshot = table.seats
    .filter(s => s.playerId && s.status !== 'empty')
    .map(s => ({ playerId: s.playerId, nickname: s.nickname, seat: s.position, stack: s.stack, cards: s.cards || [] }));

  table.handLogger.persist({
    tableId: table.id,
    tournamentId: table.tournamentId || null,
    handNumber: table.handNumber,
    gameType: table.gameType,
    chipMode: table.chipMode,
    players: playersSnapshot,
    community: table.community,
    potTotal: table.potManager.totalPot(),
    winners,
  }).catch(err => console.error('[HandLogger] persist error:', err));

  // Reveal hands — only players who made it to showdown (active/all_in, not folded)
  const showdownPlayers = table.seats.filter(s =>
    s.playerId && ['active', 'all_in'].includes(s.status) && s.cards?.length > 0
  );
  console.log('[Showdown] seats:', table.seats.filter(s => s.status !== 'empty').map(s => `${s.nickname}(pos${s.position},${s.status},cards:${s.cards?.length})`).join(', '));
  const revealedHands = showdownPlayers.map(s => ({
    playerId: s.playerId,
    nickname: s.nickname,
    cards: s.cards,
    handName: rankedPlayers.find(p => p.playerId === s.playerId)?.hand?.name || null,
  }));

  emitToTable(table.id, 'hand_ended', { winners, hands: revealedHands, earlyEnd: !!earlyEnd });

  // Send detailed dealer chat messages in Spanish with card symbols
  const SUIT_SYMBOL = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const RANK_DISPLAY = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
  function cardStr(card) {
    const r = RANK_DISPLAY[card.rank] || card.rank;
    const s = SUIT_SYMBOL[card.suit] || card.suit;
    return `${r}${s}`;
  }
  function cardsStr(cards) {
    return cards.map(cardStr).join(' ');
  }

  // Winner message
  for (const w of winners) {
    const handStr = w.handName && w.handName !== 'Winner' ? ` con ${w.handName}` : '';
    const winnerCards = w.cards?.length ? ` [${cardsStr(w.cards)}]` : '';
    const msg = earlyEnd
      ? `${w.nickname} gana $${w.amount} (los demás se retiraron)`
      : `${w.nickname} gana $${w.amount}${handStr}${winnerCards}`;
    emitToTable(table.id, 'chat_received', {
      playerId: null, nickname: 'Dealer', text: msg, type: 'dealer', at: new Date().toISOString(),
    });
  }

  // Community cards message
  if (table.community.length > 0 && !earlyEnd) {
    emitToTable(table.id, 'chat_received', {
      playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
      text: `Mesa: ${cardsStr(table.community)}`,
    });
  }

  // All showdown hands
  if (!earlyEnd && showdownPlayers.length > 1) {
    for (const s of showdownPlayers) {
      const rp = rankedPlayers.find(p => p.playerId === s.playerId);
      const handName = rp?.hand?.name || '';
      const isW = winners.some(w => w.playerId === s.playerId);
      emitToTable(table.id, 'chat_received', {
        playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
        text: `${isW ? '👑 ' : ''}${s.nickname}: ${cardsStr(s.cards)} → ${handName}`,
      });
    }
  }

  // Players with 0 chips are busted. Cash: deja la mesa (rebuy desde el lobby).
  // Torneo: eliminado (se registra su posición antes de liberar el asiento).
  const busted = table.seats.filter(s => s.playerId && s.status !== 'empty' && s.stack === 0);
  for (const s of busted) {
    s.status = 'sitting_out';
    emitToTable(table.id, 'chat_received', {
      playerId: null, nickname: 'Dealer', type: 'dealer', at: new Date().toISOString(),
      text: table.isTournament
        ? `${s.nickname} fue eliminado del torneo`
        : `${s.nickname} se quedó sin fichas y deja la mesa`,
    });
  }
  // Torneo: avisar al manager de las eliminaciones (para final_position) antes de liberar.
  // Se incluye al mayor ganador de la mano (el "cazador") para pagar bounties.
  if (busted.length && table.isTournament && table.onBust) {
    const hunter = winners.length
      ? [...winners].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0]
      : null;
    table.onBust(
      busted.map(s => ({ playerId: s.playerId, nickname: s.nickname })),
      hunter ? { playerId: hunter.playerId, nickname: hunter.nickname } : null
    );
  }
  if (busted.length) {
    const bustedIds = busted.map(s => s.playerId);
    // Remove after the winner celebration so players see what happened
    setTimeout(() => {
      for (const pid of bustedIds) {
        const seat = table.seats.find(s => s.playerId === pid);
        if (seat && seat.stack === 0) {
          seat.playerId = null;
          seat.nickname = null;
          seat.status = 'empty';
          seat.cards = [];
          emitToTable(table.id, 'player_left', { playerId: pid });
        }
      }
    }, 4000);
  }

  for (const s of table.seats) {
    if (s.playerId && s.status !== 'empty' && s.status !== 'sitting_out' ) s.status = 'active';
  }

  table.phase = 'waiting';
  table.potManager = new PotManager();

  // Torneo: dejar que el manager revise si ya hay ganador o suba las ciegas
  if (table.isTournament && table.onHandComplete) table.onHandComplete(table);

  // Auto-start next hand after delay (salvo que el torneo ya haya terminado)
  if (!table.tournamentOver) setTimeout(() => startHand(table), 5000);
}

// Called when a player leaves mid-hand: fold them and keep the game moving.
// Returns true if the player was in an active hand.
function handlePlayerExit(table, playerId) {
  const seat = table.seats.find(s => s.playerId === playerId);
  if (!seat) return false;

  const inActiveHand = table.phase !== 'waiting' && ['active', 'all_in'].includes(seat.status);
  if (!inActiveHand) return false;

  const wasTheirTurn = table.actionPosition === seat.position;
  seat.status = 'folded';
  table.handLogger?.log(playerId, 'fold', 0, table.potManager?.totalPot() || 0);

  emitToTable(table.id, 'action_broadcast', {
    playerId, type: 'fold', amount: 0,
    pot: table.potManager?.totalPot() || 0,
  });

  const stillInHand = table.seats.filter(s => s.playerId && ['active', 'all_in'].includes(s.status));
  if (stillInHand.length <= 1) {
    clearTimeout(table.actionTimeout);
    endStreet(table, true);
  } else if (wasTheirTurn) {
    clearTimeout(table.actionTimeout);
    advanceAction(table);
  }
  return true;
}

module.exports = { startHand, processAction, setIo, publicTableState, handlePlayerExit, emitToTable, emitToPlayer };
