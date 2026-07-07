# Master Plan — PokerSite (Texas Hold'em No Limit)

## Contexto

PokerSite es una plataforma de póker Texas Hold'em (backend Node/Express/MySQL/Socket.io,
web React/Vite/Tailwind, móvil React Native, PWA). Hoy funciona como **fichas de práctica
(play money)** para jugar y hacer campeonatos con amigos/testers. El dueño pidió un
**inventario tipo plataforma profesional** (PokerStars/GGPoker/WPT/PartyPoker/888),
comparado con lo que ya existe, y una **hoja de ruta priorizada** — como referencia, sin
implementar todavía.

**Decisiones que acotan el alcance (confirmadas):**
- **Solo play money.** Quedan FUERA: licencia/regulación, KYC/AML, retiros de dinero real,
  RNG certificado por auditor, wallet con cumplimiento financiero. (Se indica dónde
  impactarían si algún día se va a dinero real.)
- Objetivo: documento de referencia + roadmap. No se codifica aún.

---

## Estado actual (verificado en el código)

Rutas backend: `auth, tables, tournaments, hands, players, admin`.
Motor: `gameStateMachine, potManager, handEvaluator, deck, actionValidator, tableManager,
tournamentManager, handLogger` + bots (`BotEngine/BotClient/BotManager`).
Tablas MySQL: `players, tables_cash, tournaments, tournament_registrations, hand_history,
bots, tester_labels, chip_transactions`.
Web: `Lobby, Table, History, HandReplay, Profile, Stats` + admin (`Bots, Tournaments,
Accuracy`) + mesa completa (`PokerTable` con capas de animación, HUD y Clasificación de torneo).

**Ya sólido ✅:** motor de mano completo (blinds, side/main pots, all-in, showdown, evaluador,
split), cash con rebuy/sit-out/notas, **torneos MTT** (multi-mesa, rebalanceo, romper mesas,
mesa final, premios, ITM, HUD, clasificación estilo PokerStars, **inicio programado**),
historial + replay, avatares (DiceBear), animaciones, chat/emojis, PWA, panel admin, bots con
6 niveles y reconexión.

---

## Inventario de módulos vs PokerSite (✅ tiene · ⚠️ parcial/mejorar · ❌ falta)

### Motor de póker
| Función | Estado |
|---|---|
| Dealer/SB/BB, reparto, side/main pots, all-in, split, showdown, ranking, empates | ✅ |
| Shuffle / RNG | ⚠️ usa `Math.random()` (deck.js) → cambiar a `crypto.randomInt` (justo/anti-predicción) |
| Validaciones de acción | ✅ (actionValidator) |
| Antes / Ante-BB | ❌ |
| Straddle, Bomb Pot | ❌ |
| Run It Twice, Rabbit Hunt | ❌ |
| Time Bank | ❌ (solo timeout fijo 30s → auto-fold/check) |

### Cash games
| Función | Estado |
|---|---|
| Crear mesa, unirse, sit-out, rebuy, notas por jugador | ✅ |
| Auto-muck, auto-fold, auto-rebuy, auto-topup | ⚠️ casillas UI sin lógica real |
| Lista de espera, reservar/cambiar asiento | ❌ |
| Table balancing entre mesas cash | ❌ (existe en torneos, no en cash) |

### Lobby y modalidades
| Función | Estado |
|---|---|
| Lobby lista mesas + torneos; Cash, Sit&Go, MTT | ✅ |
| Freerolls, Satélites, KO/PKO/Mystery Bounty, Turbo/Hyper/Deep, Heads-Up, Short Deck | ❌ |
| Mesas privadas / Home Games (código de invitación) | ❌ |
| **Entrar/re-entrar a torneo en curso desde el lobby** | ⚠️ hay endpoint `my-table`; falta el botón en el lobby (Fase 1) |

### Torneos MTT
| Función | Estado |
|---|---|
| Inscripción, arranque (lleno/manual/**programado**), multi-mesa, rebalanceo, romper mesas, mesa final, prize pool, payouts, ITM, burbuja, finalización | ✅ |
| Late Registration | ❌ |
| Re-entry / Rebuy / Add-On | ❌ |
| Bounty / PKO / Mystery Bounty | ❌ |
| Fases / Flights (Day 1/Day 2) | ❌ |
| Breaks (pausas programadas) | ❌ |
| Reloj/relator de torneo | ⚠️ HUD muestra nivel/ciegas/restantes; sin reloj de nivel ni breaks |

### Fast Fold (Zoom/Rush) y Multi-tabling
| Función | Estado |
|---|---|
| Fast Fold (pool dinámico, reasignación al foldear) | ❌ |
| Multi-mesa cliente (grid/tile/cascade, hotkeys, foco) | ❌ |

### Wallet
| Función | Estado |
|---|---|
| Saldo de fichas, transacciones (chip_transactions), buy-in de torneo | ✅ |
| Recargas Culqi/Stripe | ✅ (solo relevante si algún día hay dinero real) |
| Bonos, rakeback, cashback, transferencias | ❌ |
| Bloqueos/auditoría financiera | ⚠️ básico |

### Usuarios / Perfil / Config
| Función | Estado |
|---|---|
| Registro, login (JWT), roles, perfil, avatar, historial | ✅ |
| Recuperación de contraseña | ❌ |
| Idioma, zona horaria | ❌ (UI en español fija) |
| Config de juego: 4-colores, tema, sonidos, animaciones, auto-acciones, atajos | ⚠️ solo mute de sonido |

### Estadísticas e Historial
| Función | Estado |
|---|---|
| Historial de manos + replay + filtros | ✅ |
| Stats del jugador (página Stats) | ⚠️ básica; faltan VPIP/PFR/3Bet/WTSD/BB100/ROI del JUGADOR (los bots sí modelan VPIP internamente) |
| Export/Import HH estándar, leaderboards | ❌ |

### Chat / Social / Notificaciones / VIP
| Función | Estado |
|---|---|
| Chat de mesa + emojis + relator del dealer | ✅ |
| Chat privado, GIF, silenciar, reportar, moderación | ❌ |
| Notificaciones (push/correo) | ❌ |
| Sistema VIP (niveles, misiones, logros, insignias, recompensas) | ❌ |

### Seguridad / Integridad
| Función | Estado |
|---|---|
| JWT, roles admin, no filtrar nivel de bots ni cartas ajenas | ✅ |
| RNG seguro | ❌ `Math.random()` → `crypto` |
| Rate limiting activo | ⚠️ dep `express-rate-limit` instalada; confirmar/activar en auth y acciones |
| Anti-colusión, multicuenta, chip-dumping, ghosting, fingerprint, captcha | ❌ (play money: versión ligera de detección de abuso) |
| Reconexión de jugador humano robusta | ⚠️ bots reconectan; humanos: revisar/endurecer |

### Administración / Operación
| Función | Estado |
|---|---|
| Panel admin (bots, torneos, precisión de testers) | ✅ |
| Dashboard en vivo (economía/mesas/torneos), logs, roles/moderadores, noticias/promos, mantenimiento | ⚠️/❌ parcial |

### Casos especiales / Infra
| Función | Estado |
|---|---|
| Desconexión/timeout/abandono con auto-acción | ✅ (auto-fold 30s) |
| Caída/reinicio del servidor: **torneos y bots viven en memoria** → se pierden | ⚠️ riesgo clave (Fase 0) |
| Rollback/reembolso, cancelación de torneo | ❌ |
| Redis, colas, microservicios, balanceadores, cache | ❌ (monolito en memoria; ok para escala amigos) |

---

## Brechas más importantes para el caso actual (play money + campeonatos con amigos)

1. **Persistencia de torneos/mesas** — hoy viven en RAM; un reinicio los borra (lo sufrimos toda
   la sesión reseteando bots). Riesgo #1 para los "super torneos" del fin de semana.
2. **Entrar/re-entrar al torneo desde el lobby** — el inscrito no tiene botón claro para saltar a
   su mesa una vez arrancó (responde tu pregunta de hoy: hoy solo por URL directa vía `my-table`).
3. **Late registration / re-entry** — para campeonatos reales con amigos suele ser imprescindible.
4. **RNG cripto** — barato y correcto; da justicia y evita predicción incluso en play money.
5. **Reloj de torneo + breaks + avisos** — cuenta regresiva al inicio, pausas, "empieza en…".
6. **Experiencia de jugador** — config (4-colores, sonidos, auto-muck real), reconexión humana,
   stats propias (VPIP/PFR).

---

## Hoja de ruta priorizada (por fases, con dependencias)

De cimientos → flujo de torneo → experiencia → modalidades → social → escala.

### Fase 0 — Robustez (habilita todo lo demás)
- **Persistir estado de torneos/mesas** (snapshot en DB o Redis; rehidratar al arrancar).
  Desbloquea torneos "en serio" sin perderlos al reiniciar. Dep: ninguna.
- **RNG con `crypto.randomInt`** en `deck.js`. Trivial, alto valor. Dep: ninguna.
- **Activar/confirmar rate-limit** en auth y acciones; endurecer reconexión de humanos.

### Fase 1 — Flujo de torneo completo para amigos (lo que preguntaste hoy)
- **Lobby: inscribirse a torneos programados** + ver `starts_at` con **cuenta regresiva**.
- **Botón "Entrar/Volver al torneo"** en el lobby para inscritos (usa `GET /tournaments/:id/my-table`).
  → Responde "¿puedo entrar aunque ya empezó?": sí, con este botón.
- **Late Registration** (ventana configurable) + **Re-entry / Rebuy / Add-On**.
- **Reloj de nivel + Breaks** programados; avisos ("empieza en 5 min", "3 para premios").
  Dep: Fase 0 (persistencia) para sobrevivir reinicios.

### Fase 2 — Experiencia de mesa (pulido)
- **Config del jugador**: 4-colores, tema, sonidos, **auto-muck/auto-fold reales**, atajos.
- **Time Bank** (además del timeout).
- **Antes / Ante-BB** en torneos; opcional **Straddle** en cash.
- **Reconexión humana** robusta (volver a tu asiento tras cerrar/abrir la app).
- **Stats propias** (VPIP/PFR/3Bet/WTSD/BB100) en Stats + leaderboards.

### Fase 3 — Modalidades nuevas
- **Freerolls** y **Bounty/PKO** (reusa payouts + premio por eliminación).
- **Mesas privadas / Home Games** (código de invitación) — ideal para grupos de amigos.
- **Turbo/Hyper/Deep** como presets de ciegas (ya existe `blindSchedule`, falta exponerlo).
- **Heads-Up** y **Short Deck** (variante de evaluador).

### Fase 4 — Social, retención y operación
- **Notificaciones** (push web / correo): torneo por empezar, tu turno, premio.
- **Sistema VIP / misiones / logros / insignias** (recompensas en fichas de práctica).
- **Dashboard admin** en vivo (economía de fichas, mesas, torneos, logs) + moderación de chat.
- **Anti-abuso ligero** (multicuenta/colusión básica) — útil aun en play money.

### Fase 5 — Escala y avanzado (solo si crece mucho)
- **Fast Fold (Zoom)** con pool dinámico; **Multi-tabling** en cliente (grid/tiles/hotkeys).
- **Redis + colas**, separar el servidor de juego si suben usuarios.
- **Run It Twice / Rabbit Hunt**, satélites, fases Day1/Day2.

> Si algún día se pasa a **dinero real**, se inserta ANTES de todo una fase de cumplimiento
> (licencia Perú, KYC/AML, RNG certificado, auditoría financiera, retiros, anti-fraude fuerte).
> Es un proyecto regulado aparte; este roadmap asume play money.

---

## Entrega y verificación

- Este documento es la **referencia**. Sugerencia: al salir de modo plan, guardarlo como
  `MASTER_PLAN.md` en el repo para tu hijo/testers.
- Cada fase se implementa y se **verifica en el navegador** con las herramientas de preview
  (login como tester, medir/observar) — sin pedir capturas, como con la mesa y el HUD.
- Recomendado empezar por **Fase 0 (persistencia + RNG)**: quita el dolor de perder torneos al
  reiniciar y es prerrequisito de campeonatos "en serio".
