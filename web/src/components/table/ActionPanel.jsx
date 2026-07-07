import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChipStack } from './ChipStack';

export function ActionPanel({ isMobile = false, compact = false, autoFold = false, onToggleAutoFold, actionRequired, myPlayerId, mySeat, currentBet, lastRaiseSize, pot = 0, bigBlind = 10, onAction, onRevealCards, canReveal }) {
  const isMyTurn = actionRequired && actionRequired.playerId === myPlayerId;
  const stack = mySeat?.stack || 0;
  const streetBet = mySeat?.currentStreetBet || 0;
  // Server-authoritative amounts (action_required carries them); fall back to derived
  const owed = actionRequired?.toCall !== undefined
    ? actionRequired.toCall
    : Math.max(0, (currentBet || 0) - streetBet);
  const canCheck = owed === 0;
  const minRaise = actionRequired?.minRaiseTo !== undefined
    ? actionRequired.minRaiseTo
    : (currentBet || 0) + (lastRaiseSize || bigBlind || 10);

  const [raiseAmount, setRaiseAmount] = useState(minRaise);

  useEffect(() => {
    setRaiseAmount(Math.min(minRaise, stack + streetBet));
  }, [minRaise, stack, streetBet]);

  if (!isMyTurn) {
    return (
      <div className="flex items-center justify-between py-3 px-4 gap-3">
        <span className="text-gray-600 text-sm">Esperando turno...</span>
        <label className={`flex items-center gap-1.5 cursor-pointer text-xs font-semibold ${autoFold ? 'text-yellow-300' : 'text-gray-500'}`}>
          <input type="checkbox" className="w-3.5 h-3.5 accent-yellow-500" checked={autoFold} onChange={onToggleAutoFold} />
          AUSENTE (auto-fold)
        </label>
        {canReveal && (
          <button
            onClick={onRevealCards}
            className="px-4 py-2 text-yellow-400 border border-yellow-600 hover:bg-yellow-900/30 rounded text-xs font-bold transition-colors"
          >
            👁 MOSTRAR CARTAS
          </button>
        )}
      </div>
    );
  }

  const maxRaise = stack + streetBet;
  const potRaise = Math.min((currentBet || 0) + (pot || 0), maxRaise);

  // ── Móvil: barra full-width. Se compacta en pantallas chicas (celular). ──
  if (isMobile) {
    // Tamaños proporcionales al tamaño de pantalla: celular chico = compacto,
    // tablet = cómodo. Se respeta ≥44px táctil en los botones principales.
    const quickH = compact ? 'min-h-[30px]' : 'min-h-[44px]';
    const mainH = compact ? 'min-h-[44px] py-1' : 'min-h-[52px] py-3';
    const mainTxt = compact ? 'text-[13px]' : 'text-sm';
    const subTxt = compact ? 'text-[10px]' : 'text-xs';
    return (
      <div className={`flex flex-col ${compact ? 'gap-1 px-1.5 py-1' : 'gap-2 px-2 py-2'}`}>
        {/* Controles de subida */}
        <div className="flex items-center gap-1.5">
          <button onClick={() => setRaiseAmount(minRaise)} className={`raise-quick-btn flex-1 ${quickH} ${subTxt}`}>MIN</button>
          <button onClick={() => setRaiseAmount(Math.min(potRaise, maxRaise))} className={`raise-quick-btn flex-1 ${quickH} ${subTxt}`}>BOTE</button>
          <button onClick={() => setRaiseAmount(maxRaise)} className={`raise-quick-btn flex-1 ${quickH} ${subTxt}`}>MAX</button>
          <span className={`w-14 text-center ${subTxt} font-mono text-white bg-gray-900 border border-gray-600 rounded px-1 ${quickH} flex items-center justify-center`}>{raiseAmount}</span>
        </div>
        {/* Slider */}
        <input
          type="range" min={minRaise} max={maxRaise} step={bigBlind} value={raiseAmount}
          onChange={e => setRaiseAmount(Number(e.target.value))}
          className={`w-full accent-yellow-500 ${compact ? 'h-2' : 'h-3'}`}
        />
        {/* Botones principales — esquema de color estilo Farmz */}
        <div className={`flex items-stretch gap-1.5 font-bold text-white ${mainTxt}`}>
          <button onClick={() => onAction('fold')} className={`flex-1 rounded ${mainH}`}
            style={{ background: 'linear-gradient(180deg,#e53935,#b71c1c)', border: '1px solid #ef5350' }}>
            RETIRARSE
          </button>
          {canCheck ? (
            <button onClick={() => onAction('check')} className={`flex-1 rounded ${mainH}`}
              style={{ background: 'linear-gradient(180deg,#1e88e5,#0d47a1)', border: '1px solid #42a5f5' }}>
              PASAR
            </button>
          ) : (
            <button onClick={() => onAction('call', owed)} className={`flex-1 rounded leading-tight ${mainH}`}
              style={{ background: 'linear-gradient(180deg,#9c27b0,#6a1b9a)', border: '1px solid #ba68c8' }}>
              IGUALAR<br /><span className={`${subTxt} font-normal`}>{owed}</span>
            </button>
          )}
          <button
            onClick={() => raiseAmount >= maxRaise ? onAction('all_in') : onAction('raise', raiseAmount)}
            disabled={stack <= owed}
            className={`flex-1 rounded leading-tight ${mainH} disabled:opacity-40`}
            style={{ background: 'linear-gradient(180deg,#fb8c00,#e65100)', border: '1px solid #ffa726' }}>
            {raiseAmount >= maxRaise ? 'TODO' : 'SUBIR'}<br />
            <span className={`${subTxt} font-normal`}>{raiseAmount >= maxRaise ? stack : raiseAmount}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Opciones */}
      <div className="flex flex-col gap-1 text-[10px]">
        <label className={`flex items-center gap-1 cursor-pointer ${autoFold ? 'text-yellow-300' : 'text-gray-500 hover:text-gray-300'}`}>
          <input type="checkbox" className="w-3 h-3 accent-yellow-500" checked={autoFold} onChange={onToggleAutoFold} /> AUSENTE (AUTO-FOLD)
        </label>
      </div>

      <div className="flex-1" />

      {/* Botones de acción */}
      <div className="flex items-center gap-2">
        {/* FOLD */}
        <motion.button
          whileTap={{ scale: 0.92 }}
          whileHover={{ scale: 1.04 }}
          onClick={() => onAction('fold')}
          className="px-5 py-2.5 text-white font-bold text-sm rounded"
          style={{
            background: 'linear-gradient(180deg, #e53935 0%, #b71c1c 100%)',
            border: '1px solid #ef5350',
            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
          }}
        >
          RETIRARSE
        </motion.button>

        {/* PASAR — always visible, disabled whenever there's a bet to match */}
        <motion.button
          whileTap={canCheck ? { scale: 0.92 } : {}}
          whileHover={canCheck ? { scale: 1.04 } : {}}
          onClick={() => canCheck && onAction('check')}
          disabled={!canCheck}
          className="px-5 py-2.5 font-bold text-sm rounded disabled:cursor-not-allowed"
          style={canCheck ? {
            background: 'linear-gradient(180deg, #1e88e5 0%, #0d47a1 100%)',
            border: '1px solid #42a5f5',
            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
            color: '#fff',
          } : {
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            color: '#666',
          }}
          title={canCheck ? '' : 'Hay una apuesta — debes igualar o retirarte'}
        >
          PASAR
        </motion.button>

        {/* IGUALAR — only when facing a bet */}
        {!canCheck && (
          <motion.button
            whileTap={{ scale: 0.92 }}
            whileHover={{ scale: 1.04 }}
            onClick={() => onAction('call', owed)}
            className="px-5 py-2.5 text-white font-bold text-sm rounded"
            style={{
              background: 'linear-gradient(180deg, #9c27b0 0%, #6a1b9a 100%)',
              border: '1px solid #ba68c8',
              boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
            }}
          >
            IGUALAR<br /><span className="text-xs font-normal">{owed}</span>
          </motion.button>
        )}

        {/* Raise section */}
        <div className="flex flex-col gap-1">
          <div className="flex gap-0.5">
            <button onClick={() => setRaiseAmount(minRaise)} className="raise-quick-btn">MIN</button>
            <button onClick={() => setRaiseAmount(Math.min(potRaise, maxRaise))} className="raise-quick-btn">BOTE</button>
            <button onClick={() => setRaiseAmount(maxRaise)} className="raise-quick-btn">MAX</button>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="range"
              min={minRaise}
              max={maxRaise}
              step={bigBlind}
              value={raiseAmount}
              onChange={e => setRaiseAmount(Number(e.target.value))}
              className="w-20 h-1.5 accent-yellow-500"
            />
            <input
              type="number"
              value={raiseAmount}
              onChange={e => setRaiseAmount(Math.min(Math.max(Number(e.target.value), minRaise), maxRaise))}
              className="w-14 text-center text-xs font-mono text-white bg-gray-900 border border-gray-600 rounded px-1 py-0.5"
            />
          </div>
        </div>

        {/* Chip preview of the raise amount */}
        <div className="hidden sm:block">
          <ChipStack amount={raiseAmount} size={16} showLabel={false} />
        </div>

        {/* RAISE button */}
        <motion.button
          whileTap={{ scale: 0.92 }}
          whileHover={{ scale: 1.04 }}
          onClick={() => raiseAmount >= maxRaise ? onAction('all_in') : onAction('raise', raiseAmount)}
          disabled={stack <= owed}
          className="px-5 py-2.5 text-white font-bold text-sm rounded disabled:opacity-40"
          style={{
            background: 'linear-gradient(180deg, #fb8c00 0%, #e65100 100%)',
            border: '1px solid #ffa726',
            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
          }}
        >
          {raiseAmount >= maxRaise ? 'TODO' : 'SUBIR A'}<br />
          <span className="text-xs font-normal">{raiseAmount >= maxRaise ? stack : raiseAmount}</span>
        </motion.button>
      </div>
    </div>
  );
}
