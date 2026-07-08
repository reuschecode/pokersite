'use strict';

// Siembra 100 bots con nombres humanos peruanos, repartidos en niveles 5–10.
// Idempotente: el ID de cada bot deriva del nombre (MD5), así que reejecutar
// no duplica. Cada bot recibe una "personalidad" determinista (aggro/tight)
// para que dos bots del mismo nivel no jueguen idéntico.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createHash } = require('crypto');
const pool = require('./src/config/db');

const NOMBRES = [
  'Carlos', 'María', 'Pedro', 'Jorge', 'Lucía', 'Rosa', 'Miguel', 'Ana', 'Luis', 'Carmen',
  'José', 'Elena', 'Juan', 'Sofía', 'Diego', 'Valeria', 'Fernando', 'Gabriela', 'Ricardo', 'Patricia',
  'Andrés', 'Camila', 'Manuel', 'Daniela', 'Roberto', 'Paola', 'Alberto', 'Silvia', 'Raúl', 'Verónica',
  'Óscar', 'Milagros', 'César', 'Fiorella', 'Walter', 'Yenifer', 'Percy', 'Katia', 'Rubén', 'Melissa',
];
const APELLIDOS = [
  'Quispe', 'Mamani', 'Flores', 'Huamán', 'Rojas', 'Vargas', 'Chávez', 'Ramos', 'Torres', 'Díaz',
  'Sánchez', 'Castillo', 'Ríos', 'Vega', 'Ccahuana', 'Cárdenas', 'Espinoza', 'Zapata', 'Ñaupas', 'Cabrera',
  'Salazar', 'Gutiérrez', 'Paredes', 'Ventura', 'Aguilar', 'Ríos', 'Palomino', 'Cusi', 'Yupanqui', 'Bravo',
];
const APODOS = ['', '', '', '_pe', '07', '10', 'crack', '_lima', 'kbz', '_cusco', '23', 'flaco', '_jr', 'x'];

// Estilos de caricatura DiceBear (open-source) que se reparten entre los bots
const BOT_STYLES = [
  'bottts', 'funEmoji', 'adventurer', 'bigSmile', 'micah',
  'openPeeps', 'personas', 'lorelei', 'notionists', 'toonHead', 'miniavs', 'croodles',
];

function botIdFor(nickname) {
  const h = createHash('md5').update(nickname).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Genera un número pseudoaleatorio estable a partir de una semilla de texto
function seededRand(seed) {
  const h = createHash('md5').update(seed).digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

function makeNicknames(n) {
  const set = new Set();
  let i = 0;
  while (set.size < n) {
    const nom = NOMBRES[i % NOMBRES.length];
    const ape = APELLIDOS[(i * 7) % APELLIDOS.length];
    const apo = APODOS[(i * 3) % APODOS.length];
    // Variedad: unos "Nombre_A", otros "NombreApellido07"
    const style = i % 3;
    let nick;
    if (style === 0) nick = `${nom}${ape}${apo}`;
    else if (style === 1) nick = `${nom}_${ape.slice(0, 3)}${apo}`;
    else nick = `${nom}${apo || (i % 90 + 10)}`;
    nick = nick.slice(0, 28);
    if (!set.has(nick)) set.add(nick);
    i++;
    if (i > 1000) break; // guardia
  }
  return [...set];
}

async function seedBots() {
  const LEVELS = [5, 6, 7, 8, 9, 10];
  const TOTAL = 100;
  const nicks = makeNicknames(TOTAL);

  let created = 0;
  const perLevel = {};
  for (let idx = 0; idx < nicks.length; idx++) {
    const nickname = nicks[idx];
    const botId = botIdFor(nickname);
    // Reparto redondo por nivel → ~16-17 por nivel
    const level = LEVELS[idx % LEVELS.length];
    perLevel[level] = (perLevel[level] || 0) + 1;

    // Personalidad determinista: aggro/tight en [-0.12, 0.12]
    const aggro = (seededRand(nickname + 'aggro') - 0.5) * 0.24;
    const tight = (seededRand(nickname + 'tight') - 0.5) * 0.24;
    const personality = { aggro: +aggro.toFixed(3), tight: +tight.toFixed(3) };

    // Avatar de caricatura: estilo determinista por bot (semilla estable = nickname)
    const style = BOT_STYLES[Math.floor(seededRand(nickname + 'style') * BOT_STYLES.length)];
    const avatarConfig = JSON.stringify({ _style: style });

    // player (is_bot=1) con stack amplio para buy-ins + avatar de caricatura
    await pool.query(
      `INSERT INTO players (id, nickname, play_chips, is_bot, avatar_config)
       VALUES (?, ?, 100000, 1, ?)
       ON DUPLICATE KEY UPDATE is_bot = 1, play_chips = GREATEST(play_chips, 100000), avatar_config = VALUES(avatar_config)`,
      [botId, nickname, avatarConfig]
    );
    // fila bots con nivel + personalidad
    await pool.query(
      `INSERT INTO bots (bot_id, level, personality_json)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE level = VALUES(level), personality_json = VALUES(personality_json)`,
      [botId, level, JSON.stringify(personality)]
    );
    created++;
  }

  console.log(`[seedBots] ${created} bots sembrados.`);
  console.log('[seedBots] Por nivel:', JSON.stringify(perLevel));
  const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM bots');
  console.log(`[seedBots] Total en tabla bots: ${n}`);
  return created;
}

module.exports = { seedBots };

// Ejecución directa: node seedBots.js
if (require.main === module) {
  seedBots()
    .then(() => process.exit(0))
    .catch(e => { console.error('[seedBots] ERROR', e); process.exit(1); });
}
