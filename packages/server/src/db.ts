import Database from 'better-sqlite3';
import crypto from 'node:crypto';

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
    `);
  }

  /** Validate a gateway token, return gateway info or null */
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

  /** Register a new gateway token */
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

  close(): void {
    this.db.close();
  }
}
