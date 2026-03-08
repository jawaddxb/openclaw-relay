import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { hashToken } from './auth.js';

// ── Existing interfaces ────────────────────────────────────────

export interface GatewayTokenRow {
  token: string;
  gateway_id: string;
  gateway_name: string;
  created_at: string;
  revoked: number;
}

export interface AppTokenRow {
  token: string;
  app_id: string;
  gateway_id: string;
  device_name: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked: number;
}

export interface PairingCodeRow {
  code: string;
  gateway_id: string;
  created_at: string;
  expires_at: string;
  used: number;
}

// ── New auth interfaces ────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  email_verified: number;
  created_at: number;
  last_login: number | null;
}

export interface UserGatewayRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  machine_id: string | null;
  machine_info: string | null;
  status: string;
  last_seen: number | null;
  created_at: number;
}

export interface DeviceAuthRow {
  device_code: string;
  user_code: string;
  user_id: string | null;
  gateway_id: string | null;
  gateway_token: string | null;
  status: string;
  machine_info: string | null;
  expires_at: number;
  interval_s: number;
  created_at: number;
}

export interface LinkTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  name: string | null;
  expires_at: number;
  used_at: number | null;
  gateway_id: string | null;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: number;
  last_used: number | null;
  expires_at: number;
}

// ── Token generation ───────────────────────────────────────────

const PAIRING_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY346789';

function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

function generateAppToken(gatewayId: string): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `app_${gatewayId}_${random}`;
}

export function generateGatewayToken(): string {
  const random = crypto.randomBytes(32).toString('base64url');
  return `gw_live_${random}`;
}

function generateLinkTokenValue(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `lnk_${random}`;
}

// ── Word code generation (RFC 8628 device auth) ───────────────

const WORD_LIST = [
  'ALPHA', 'BLAZE', 'BRAVE', 'CEDAR', 'CHASE', 'CLIFF', 'CORAL', 'CRANE', 'DUSK', 'EAGLE',
  'EMBER', 'FLAME', 'FORGE', 'FROST', 'GLADE', 'GRAPE', 'HAVEN', 'IVORY', 'JEWEL', 'KAYAK',
  'LEMON', 'LUNAR', 'MAPLE', 'NORTH', 'OCEAN', 'PEARL', 'PLUME', 'PRISM', 'QUAIL', 'RAVEN',
  'RIDGE', 'RIVER', 'ROBIN', 'SAGE', 'SHORE', 'SILK', 'SOLAR', 'SPARK', 'STEEL', 'STONE',
  'STORM', 'SWIFT', 'THORN', 'TIGER', 'TORCH', 'TULIP', 'VAPOR', 'VIVID', 'WHALE', 'WIND',
];

function generateWordCode(): string {
  const w1 = WORD_LIST[crypto.randomInt(WORD_LIST.length)];
  let w2 = WORD_LIST[crypto.randomInt(WORD_LIST.length)];
  while (w2 === w1) w2 = WORD_LIST[crypto.randomInt(WORD_LIST.length)];
  return `${w1}-${w2}`;
}

function computeMachineId(machineInfoJson: string | null): string | null {
  if (!machineInfoJson) return null;
  try {
    const info = JSON.parse(machineInfoJson);
    return crypto.createHash('sha256')
      .update(`${info.hostname || ''}|${info.os || ''}|${info.arch || ''}`)
      .digest('hex');
  } catch {
    return null;
  }
}

// ── Database ───────────────────────────────────────────────────

export class RelayDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      -- ═══ Existing tables ═══

      CREATE TABLE IF NOT EXISTS gateway_tokens (
        token TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL UNIQUE,
        gateway_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS app_tokens (
        token TEXT PRIMARY KEY,
        app_id TEXT NOT NULL UNIQUE,
        gateway_id TEXT NOT NULL,
        device_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_app_tokens_gateway ON app_tokens(gateway_id);
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_gateway ON pairing_codes(gateway_id);

      -- ═══ Auth tables ═══

      CREATE TABLE IF NOT EXISTS users (
        id              TEXT PRIMARY KEY,
        email           TEXT UNIQUE NOT NULL,
        name            TEXT,
        password_hash   TEXT,
        email_verified  INTEGER DEFAULT 0,
        created_at      INTEGER NOT NULL,
        last_login      INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_providers (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider        TEXT NOT NULL,
        provider_id     TEXT NOT NULL,
        provider_email  TEXT,
        access_token    TEXT,
        refresh_token   TEXT,
        created_at      INTEGER NOT NULL,
        UNIQUE(provider, provider_id)
      );

      CREATE TABLE IF NOT EXISTS user_gateways (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        token_hash      TEXT NOT NULL,
        machine_id      TEXT,
        machine_info    TEXT,
        status          TEXT DEFAULT 'offline',
        last_seen       INTEGER,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_auth (
        device_code     TEXT PRIMARY KEY,
        user_code       TEXT UNIQUE NOT NULL,
        user_id         TEXT REFERENCES users(id),
        gateway_id      TEXT,
        gateway_token   TEXT,
        status          TEXT DEFAULT 'pending',
        machine_info    TEXT,
        expires_at      INTEGER NOT NULL,
        interval_s      INTEGER DEFAULT 5,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS link_tokens (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash      TEXT NOT NULL,
        name            TEXT,
        expires_at      INTEGER NOT NULL,
        used_at         INTEGER,
        gateway_id      TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name     TEXT,
        ip_address      TEXT,
        user_agent      TEXT,
        created_at      INTEGER NOT NULL,
        last_used       INTEGER,
        expires_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash      TEXT NOT NULL,
        expires_at      INTEGER NOT NULL,
        used_at         INTEGER,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash      TEXT NOT NULL,
        expires_at      INTEGER NOT NULL,
        used_at         INTEGER,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_user_gateways_user ON user_gateways(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_gateways_token ON user_gateways(token_hash);
      CREATE INDEX IF NOT EXISTS idx_user_providers_user ON user_providers(user_id);
      CREATE INDEX IF NOT EXISTS idx_device_auth_user_code ON device_auth(user_code);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_user ON link_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
    `);
  }

  // ── Existing methods (backwards compat) ──────────────────────

  /** Validate a gateway token from the legacy gateway_tokens table */
  validateGatewayToken(
    token: string,
  ): { id: string; name: string } | null {
    const row = this.db
      .prepare(
        'SELECT gateway_id, gateway_name FROM gateway_tokens WHERE token = ? AND revoked = 0',
      )
      .get(token) as { gateway_id: string; gateway_name: string } | undefined;
    if (!row) return null;
    return { id: row.gateway_id, name: row.gateway_name };
  }

  /** Validate a gateway token from BOTH legacy and user_gateways tables */
  validateAnyGatewayToken(
    token: string,
  ): { id: string; name: string } | null {
    // Try legacy table first
    const legacy = this.validateGatewayToken(token);
    if (legacy) return legacy;

    // Try user_gateways by SHA-256 hash
    const th = hashToken(token);
    const row = this.db
      .prepare(
        "SELECT id, name FROM user_gateways WHERE token_hash = ?",
      )
      .get(th) as { id: string; name: string } | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name };
  }

  /** Validate an app token, return app info or null */
  validateAppToken(
    token: string,
  ): { id: string; gatewayId: string; deviceName: string } | null {
    const row = this.db
      .prepare(
        `SELECT app_id, gateway_id, device_name, expires_at
         FROM app_tokens WHERE token = ? AND revoked = 0`,
      )
      .get(token) as
      | {
          app_id: string;
          gateway_id: string;
          device_name: string;
          expires_at: string;
        }
      | undefined;
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // Touch last_used_at
    this.db
      .prepare(
        "UPDATE app_tokens SET last_used_at = datetime('now') WHERE token = ?",
      )
      .run(token);

    return {
      id: row.app_id,
      gatewayId: row.gateway_id,
      deviceName: row.device_name,
    };
  }

  /** Create a pairing code for a gateway. Returns the code and expiry. */
  createPairingCode(gatewayId: string): { code: string; expiresAt: string } {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.db
      .prepare(
        'INSERT INTO pairing_codes (code, gateway_id, expires_at) VALUES (?, ?, ?)',
      )
      .run(code, gatewayId, expiresAt);
    return { code, expiresAt };
  }

  /** Exchange a pairing code for an app token */
  exchangePairingCode(
    code: string,
    deviceName: string,
  ): {
    appToken: string;
    gatewayId: string;
  } | null {
    const row = this.db
      .prepare(
        'SELECT gateway_id, expires_at, used FROM pairing_codes WHERE code = ?',
      )
      .get(code) as
      | { gateway_id: string; expires_at: string; used: number }
      | undefined;

    if (!row) return null;
    if (row.used) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // Mark code as used
    this.db.prepare('UPDATE pairing_codes SET used = 1 WHERE code = ?').run(code);

    // Generate app token
    const appToken = generateAppToken(row.gateway_id);
    const appId = `app_${crypto.randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    this.db
      .prepare(
        'INSERT INTO app_tokens (token, app_id, gateway_id, device_name, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(appToken, appId, row.gateway_id, deviceName, expiresAt);

    return { appToken, gatewayId: row.gateway_id };
  }

  /** Register a new gateway token (legacy) */
  registerGatewayToken(
    gatewayId: string,
    gatewayName: string,
  ): string {
    const token = generateGatewayToken();
    this.db
      .prepare(
        'INSERT INTO gateway_tokens (token, gateway_id, gateway_name) VALUES (?, ?, ?)',
      )
      .run(token, gatewayId, gatewayName);
    return token;
  }

  /** List apps for a gateway */
  listApps(
    gatewayId: string,
  ): Array<{
    id: string;
    deviceName: string;
    createdAt: string;
    lastUsedAt: string;
  }> {
    const rows = this.db
      .prepare(
        'SELECT app_id, device_name, created_at, last_used_at FROM app_tokens WHERE gateway_id = ? AND revoked = 0',
      )
      .all(gatewayId) as Array<{
      app_id: string;
      device_name: string;
      created_at: string;
      last_used_at: string;
    }>;
    return rows.map((r) => ({
      id: r.app_id,
      deviceName: r.device_name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /** Revoke an app token */
  revokeApp(gatewayId: string, appId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE app_tokens SET revoked = 1 WHERE gateway_id = ? AND app_id = ?',
      )
      .run(gatewayId, appId);
    return result.changes > 0;
  }

  // ── User methods ─────────────────────────────────────────────

  createUser(
    email: string,
    name: string | null,
    passwordHash: string,
  ): { id: string; email: string; name: string | null } {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, email.toLowerCase(), name, passwordHash, now);
    return { id, email: email.toLowerCase(), name };
  }

  findUserByEmail(email: string): UserRow | null {
    return (
      this.db
        .prepare('SELECT * FROM users WHERE email = ?')
        .get(email.toLowerCase()) as UserRow | undefined
    ) ?? null;
  }

  findUserById(id: string): UserRow | null {
    return (
      this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
        | UserRow
        | undefined
    ) ?? null;
  }

  updateUserLastLogin(id: string): void {
    this.db
      .prepare('UPDATE users SET last_login = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  // ── Session methods ──────────────────────────────────────────

  createSession(
    userId: string,
    expiresAt: number,
    opts?: {
      deviceName?: string;
      ipAddress?: string;
      userAgent?: string;
    },
  ): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, device_name, ip_address, user_agent, created_at, last_used, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        userId,
        opts?.deviceName ?? null,
        opts?.ipAddress ?? null,
        opts?.userAgent ?? null,
        now,
        now,
        expiresAt,
      );
    return id;
  }

  findSession(sessionId: string): SessionRow | null {
    return (
      this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
        | SessionRow
        | undefined
    ) ?? null;
  }

  touchSession(sessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET last_used = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  deleteSession(sessionId: string, userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
      .run(sessionId, userId);
    return result.changes > 0;
  }

  listUserSessions(userId: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used DESC')
      .all(userId, Date.now()) as SessionRow[];
  }

  // ── Device auth methods (RFC 8628) ───────────────────────────

  createDeviceAuth(machineInfo?: string): {
    deviceCode: string;
    userCode: string;
    expiresAt: number;
    interval: number;
  } {
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const userCode = generateWordCode();
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes

    // Retry if user_code collides (very unlikely with 50*49 = 2450 combinations)
    try {
      this.db
        .prepare(
          'INSERT INTO device_auth (device_code, user_code, machine_info, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(deviceCode, userCode, machineInfo ?? null, expiresAt, now);
    } catch {
      // user_code collision — generate a new one
      const retryCode = generateWordCode();
      this.db
        .prepare(
          'INSERT INTO device_auth (device_code, user_code, machine_info, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(deviceCode, retryCode, machineInfo ?? null, expiresAt, now);
      return { deviceCode, userCode: retryCode, expiresAt, interval: 5 };
    }

    return { deviceCode, userCode, expiresAt, interval: 5 };
  }

  /** Authorize a pending device auth request. Creates gateway + updates device_auth. */
  authorizeDevice(
    userCode: string,
    userId: string,
    gatewayName?: string,
  ): { gatewayToken: string; gatewayId: string } | null {
    const row = this.db
      .prepare("SELECT * FROM device_auth WHERE user_code = ? AND status = 'pending'")
      .get(userCode.toUpperCase()) as DeviceAuthRow | undefined;
    if (!row) return null;

    if (Date.now() > row.expires_at) {
      this.db
        .prepare("UPDATE device_auth SET status = 'expired' WHERE device_code = ?")
        .run(row.device_code);
      return null;
    }

    // Generate gateway credentials
    const gatewayToken = generateGatewayToken();
    const tokenHash = hashToken(gatewayToken);
    const gatewayId = crypto.randomUUID();
    const machineId = computeMachineId(row.machine_info);
    const now = Date.now();

    // Derive gateway name from machine info if not provided
    let name = gatewayName || 'Gateway';
    if (!gatewayName && row.machine_info) {
      try {
        const info = JSON.parse(row.machine_info);
        name = info.hostname || 'Gateway';
      } catch { /* use default */ }
    }

    // If same user+machine already exists, update it
    if (machineId) {
      const existing = this.db
        .prepare('SELECT id FROM user_gateways WHERE user_id = ? AND machine_id = ?')
        .get(userId, machineId) as { id: string } | undefined;

      if (existing) {
        this.db
          .prepare(
            'UPDATE user_gateways SET token_hash = ?, name = ?, machine_info = ?, status = ?, last_seen = ? WHERE id = ?',
          )
          .run(tokenHash, name, row.machine_info, 'offline', now, existing.id);

        this.db
          .prepare(
            "UPDATE device_auth SET user_id = ?, gateway_id = ?, gateway_token = ?, status = 'authorized' WHERE device_code = ?",
          )
          .run(userId, existing.id, gatewayToken, row.device_code);

        return { gatewayToken, gatewayId: existing.id };
      }
    }

    // Create new gateway
    this.db
      .prepare(
        'INSERT INTO user_gateways (id, user_id, name, token_hash, machine_id, machine_info, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(gatewayId, userId, name, tokenHash, machineId, row.machine_info, now);

    this.db
      .prepare(
        "UPDATE device_auth SET user_id = ?, gateway_id = ?, gateway_token = ?, status = 'authorized' WHERE device_code = ?",
      )
      .run(userId, gatewayId, gatewayToken, row.device_code);

    return { gatewayToken, gatewayId };
  }

  /** Poll device auth status. Returns current status + credentials if authorized. */
  pollDeviceToken(deviceCode: string): {
    status: 'pending' | 'authorized' | 'expired' | 'denied';
    gatewayToken?: string;
    gatewayId?: string;
    interval?: number;
  } {
    const row = this.db
      .prepare('SELECT * FROM device_auth WHERE device_code = ?')
      .get(deviceCode) as DeviceAuthRow | undefined;

    if (!row) return { status: 'expired' };

    if (Date.now() > row.expires_at && row.status === 'pending') {
      this.db
        .prepare("UPDATE device_auth SET status = 'expired' WHERE device_code = ?")
        .run(deviceCode);
      return { status: 'expired' };
    }

    if (row.status === 'authorized' && row.gateway_token && row.gateway_id) {
      return {
        status: 'authorized',
        gatewayToken: row.gateway_token,
        gatewayId: row.gateway_id,
      };
    }

    if (row.status === 'denied') return { status: 'denied' };
    if (row.status === 'expired') return { status: 'expired' };

    return { status: 'pending', interval: row.interval_s };
  }

  // ── Link token methods ───────────────────────────────────────

  createLinkToken(
    userId: string,
    name?: string,
  ): { token: string; id: string; expiresAt: number } {
    const id = crypto.randomUUID();
    const token = generateLinkTokenValue();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes

    this.db
      .prepare(
        'INSERT INTO link_tokens (id, user_id, token_hash, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, tokenHash, name ?? null, expiresAt, now);

    return { token, id, expiresAt };
  }

  /** Redeem a link token. Creates gateway + returns credentials. */
  redeemLinkToken(
    token: string,
    gatewayName?: string,
    machineInfo?: string,
  ): { gatewayToken: string; gatewayId: string; userId: string } | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare('SELECT * FROM link_tokens WHERE token_hash = ? AND used_at IS NULL')
      .get(tokenHash) as LinkTokenRow | undefined;

    if (!row) return null;
    if (Date.now() > row.expires_at) return null;

    // Generate gateway credentials
    const gatewayToken = generateGatewayToken();
    const gwTokenHash = hashToken(gatewayToken);
    const gatewayId = crypto.randomUUID();
    const machineId = computeMachineId(machineInfo ?? null);
    const now = Date.now();
    const name = gatewayName || row.name || 'Gateway';

    // Check for existing user+machine gateway
    if (machineId) {
      const existing = this.db
        .prepare('SELECT id FROM user_gateways WHERE user_id = ? AND machine_id = ?')
        .get(row.user_id, machineId) as { id: string } | undefined;

      if (existing) {
        this.db
          .prepare(
            'UPDATE user_gateways SET token_hash = ?, name = ?, machine_info = ?, status = ?, last_seen = ? WHERE id = ?',
          )
          .run(gwTokenHash, name, machineInfo ?? null, 'offline', now, existing.id);

        this.db
          .prepare('UPDATE link_tokens SET used_at = ?, gateway_id = ? WHERE id = ?')
          .run(now, existing.id, row.id);

        return { gatewayToken, gatewayId: existing.id, userId: row.user_id };
      }
    }

    // Create new gateway
    this.db
      .prepare(
        'INSERT INTO user_gateways (id, user_id, name, token_hash, machine_id, machine_info, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(gatewayId, row.user_id, name, gwTokenHash, machineId, machineInfo ?? null, now);

    this.db
      .prepare('UPDATE link_tokens SET used_at = ?, gateway_id = ? WHERE id = ?')
      .run(now, gatewayId, row.id);

    return { gatewayToken, gatewayId, userId: row.user_id };
  }

  // ── User gateway methods ─────────────────────────────────────

  listUserGateways(userId: string): UserGatewayRow[] {
    return this.db
      .prepare('SELECT * FROM user_gateways WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as UserGatewayRow[];
  }

  findUserGateway(id: string, userId: string): UserGatewayRow | null {
    return (
      this.db
        .prepare('SELECT * FROM user_gateways WHERE id = ? AND user_id = ?')
        .get(id, userId) as UserGatewayRow | undefined
    ) ?? null;
  }

  updateUserGateway(
    id: string,
    userId: string,
    updates: { name?: string },
  ): boolean {
    if (updates.name !== undefined) {
      const result = this.db
        .prepare('UPDATE user_gateways SET name = ? WHERE id = ? AND user_id = ?')
        .run(updates.name, id, userId);
      return result.changes > 0;
    }
    return false;
  }

  deleteUserGateway(id: string, userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM user_gateways WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  }

  /** Update gateway online/offline status (called from hub events) */
  updateGatewayStatus(gatewayId: string, status: 'online' | 'offline'): void {
    this.db
      .prepare('UPDATE user_gateways SET status = ?, last_seen = ? WHERE id = ?')
      .run(status, Date.now(), gatewayId);
  }

  // ── Email Verification ──────────────────────────────────────

  createEmailVerificationToken(userId: string): { token: string; id: string; expiresAt: number } {
    const id = crypto.randomUUID();
    const rawToken = `ev_${crypto.randomBytes(24).toString('base64url')}`;
    const tokenHash = hashToken(rawToken);
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    // Invalidate previous tokens for this user
    this.db
      .prepare('UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .run(Date.now(), userId);

    this.db
      .prepare('INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, tokenHash, expiresAt, Date.now());

    return { token: rawToken, id, expiresAt };
  }

  verifyEmail(token: string): { userId: string } | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare('SELECT user_id FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(tokenHash, Date.now()) as { user_id: string } | undefined;

    if (!row) return null;

    this.db
      .prepare('UPDATE email_verification_tokens SET used_at = ? WHERE token_hash = ?')
      .run(Date.now(), tokenHash);

    this.db
      .prepare('UPDATE users SET email_verified = 1 WHERE id = ?')
      .run(row.user_id);

    return { userId: row.user_id };
  }

  // ── Password Reset ─────────────────────────────────────────

  createPasswordResetToken(userId: string): { token: string; id: string; expiresAt: number } {
    const id = crypto.randomUUID();
    const rawToken = `pr_${crypto.randomBytes(24).toString('base64url')}`;
    const tokenHash = hashToken(rawToken);
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

    // Invalidate previous tokens
    this.db
      .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .run(Date.now(), userId);

    this.db
      .prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, tokenHash, expiresAt, Date.now());

    return { token: rawToken, id, expiresAt };
  }

  resetPassword(token: string, newPasswordHash: string): { userId: string } | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(tokenHash, Date.now()) as { user_id: string } | undefined;

    if (!row) return null;

    this.db
      .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?')
      .run(Date.now(), tokenHash);

    this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(newPasswordHash, row.user_id);

    // Invalidate all sessions (force re-login)
    this.db
      .prepare('DELETE FROM sessions WHERE user_id = ?')
      .run(row.user_id);

    return { userId: row.user_id };
  }

  close(): void {
    this.db.close();
  }
}
