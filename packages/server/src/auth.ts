import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

/** SHA-256 hash for tokens (gateway tokens, session tokens, link tokens) */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface JWTPayload {
  sub: string;  // user ID
  sid: string;  // session ID
  email: string;
}

export function signJWT(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyJWT(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

// ── Simple in-memory rate limiter ──────────────────────────────

const rateLimits = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxAttempts) {
    return false;
  }

  entry.count++;
  return true;
}

// Cleanup stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, 60_000).unref();
