const mysql = require('mysql2/promise');
const pool = require('./db');

async function setupDb() {
  // Create database if not exists (connect without DB first)
  const tempConn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'pokersite'}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await tempConn.end();

  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS players (
      id            CHAR(36)      NOT NULL DEFAULT (UUID()),
      email         VARCHAR(128)  UNIQUE,
      nickname      VARCHAR(32)   NOT NULL,
      password_hash VARCHAR(255),
      avatar_config JSON,
      play_chips    INT           NOT NULL DEFAULT 1000,
      real_chips    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      country       CHAR(2),
      is_admin      TINYINT(1)    NOT NULL DEFAULT 0,
      is_banned     TINYINT(1)    NOT NULL DEFAULT 0,
      created_at    DATETIME      NOT NULL DEFAULT NOW(),
      last_seen     DATETIME      NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id),
      INDEX idx_nickname (nickname),
      INDEX idx_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS tables_cash (
      id              CHAR(36)      NOT NULL DEFAULT (UUID()),
      name            VARCHAR(64)   NOT NULL,
      game_type       ENUM('holdem','omaha','five_card_draw','seven_card_stud') NOT NULL DEFAULT 'holdem',
      chip_mode       ENUM('play','real') NOT NULL DEFAULT 'play',
      max_seats       TINYINT       NOT NULL DEFAULT 6,
      small_blind     DECIMAL(10,2) NOT NULL DEFAULT 5,
      big_blind       DECIMAL(10,2) NOT NULL DEFAULT 10,
      buy_in_min      DECIMAL(10,2) NOT NULL DEFAULT 100,
      buy_in_max      DECIMAL(10,2) NOT NULL DEFAULT 1000,
      rake_percent    DECIMAL(4,2)  NOT NULL DEFAULT 5.00,
      rake_cap        DECIMAL(10,2) NOT NULL DEFAULT 3.00,
      status          ENUM('waiting','active','closed') NOT NULL DEFAULT 'waiting',
      created_at      DATETIME      NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS tournaments (
      id                   CHAR(36)      NOT NULL DEFAULT (UUID()),
      name                 VARCHAR(128)  NOT NULL,
      game_type            ENUM('holdem','omaha','five_card_draw','seven_card_stud') NOT NULL DEFAULT 'holdem',
      chip_mode            ENUM('play','real') NOT NULL DEFAULT 'play',
      tournament_type      ENUM('sit_and_go','scheduled') NOT NULL,
      max_players          SMALLINT      NOT NULL DEFAULT 9,
      min_players          SMALLINT      NOT NULL DEFAULT 2,
      buy_in               DECIMAL(10,2) NOT NULL DEFAULT 10,
      rake                 DECIMAL(10,2) NOT NULL DEFAULT 1,
      prize_pool           DECIMAL(10,2) NOT NULL DEFAULT 0,
      payout_json          JSON          NOT NULL,
      blind_schedule_json  JSON          NOT NULL,
      status               ENUM('registering','running','finished','cancelled') NOT NULL DEFAULT 'registering',
      starts_at            DATETIME      NULL,
      started_at           DATETIME      NULL,
      ended_at             DATETIME      NULL,
      created_by           CHAR(36)      NOT NULL,
      created_at           DATETIME      NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id),
      FOREIGN KEY (created_by) REFERENCES players(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS tournament_registrations (
      tournament_id   CHAR(36)      NOT NULL,
      player_id       CHAR(36)      NOT NULL,
      registered_at   DATETIME      NOT NULL DEFAULT NOW(),
      final_position  SMALLINT      NULL,
      prize_won       DECIMAL(10,2) NULL,
      PRIMARY KEY (tournament_id, player_id),
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS hand_history (
      id              BIGINT        NOT NULL AUTO_INCREMENT,
      table_id        CHAR(36)      NOT NULL,
      tournament_id   CHAR(36)      NULL,
      hand_number     INT           NOT NULL,
      game_type       ENUM('holdem','omaha','five_card_draw','seven_card_stud') NOT NULL,
      chip_mode       ENUM('play','real') NOT NULL,
      players_json    JSON          NOT NULL,
      community_json  JSON          NOT NULL,
      actions_json    JSON          NOT NULL,
      pot_total       DECIMAL(10,2) NOT NULL,
      winners_json    JSON          NOT NULL,
      started_at      DATETIME      NOT NULL,
      ended_at        DATETIME      NOT NULL,
      PRIMARY KEY (id),
      INDEX idx_table (table_id),
      INDEX idx_tournament (tournament_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS chip_transactions (
      id              BIGINT        NOT NULL AUTO_INCREMENT,
      player_id       CHAR(36)      NOT NULL,
      chip_mode       ENUM('play','real') NOT NULL,
      delta           DECIMAL(10,2) NOT NULL,
      reason          ENUM('buy_in','win','tournament_buyin','tournament_prize','deposit','withdrawal','refill','rake') NOT NULL,
      reference_id    CHAR(36)      NULL,
      payment_gateway ENUM('culqi','stripe') NULL,
      gateway_tx_id   VARCHAR(128)  NULL,
      created_at      DATETIME      NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id),
      FOREIGN KEY (player_id) REFERENCES players(id),
      INDEX idx_player (player_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Migration: share token for public hand replays
    try {
      await conn.query(`ALTER TABLE hand_history ADD COLUMN share_token VARCHAR(40) NULL, ADD INDEX idx_share (share_token)`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Migration: bot flag on players (nivel real vive aparte, nunca se expone)
    try {
      await conn.query(`ALTER TABLE players ADD COLUMN is_bot TINYINT(1) NOT NULL DEFAULT 0`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Migration: snapshot del runtime del torneo (persistencia ante reinicios)
    try {
      await conn.query(`ALTER TABLE tournaments ADD COLUMN runtime_json LONGTEXT NULL`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Migration: mesas privadas con código de invitación (home games)
    try {
      await conn.query(`ALTER TABLE tables_cash ADD COLUMN invite_code VARCHAR(12) NULL, ADD COLUMN owner_id CHAR(36) NULL, ADD INDEX idx_invite (invite_code)`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Migration: recompensa por eliminación (torneos bounty/KO)
    try {
      await conn.query(`ALTER TABLE tournaments ADD COLUMN bounty DECIMAL(10,2) NOT NULL DEFAULT 0`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Bots: el nivel real y la personalidad viven aislados de players
    await conn.query(`CREATE TABLE IF NOT EXISTS bots (
      bot_id           CHAR(36)     NOT NULL,
      level            TINYINT      NOT NULL,
      personality_json JSON,
      created_at       DATETIME     NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot_id),
      FOREIGN KEY (bot_id) REFERENCES players(id),
      INDEX idx_level (level)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Etiquetas de los testers: qué nivel le adivinan a cada jugador/bot
    await conn.query(`CREATE TABLE IF NOT EXISTS tester_labels (
      tester_id       CHAR(36)     NOT NULL,
      target_id       CHAR(36)     NOT NULL,
      estimated_level TINYINT      NULL,
      tag             VARCHAR(16)  NULL,
      note            VARCHAR(200) NULL,
      updated_at      DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
      PRIMARY KEY (tester_id, target_id),
      INDEX idx_target (target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    console.log('[DB] Schema created/verified');
  } finally {
    conn.release();
  }
}

module.exports = setupDb;
