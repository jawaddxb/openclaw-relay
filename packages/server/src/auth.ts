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

// ── Email sender (Resend API or log-only fallback) ─────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'AgentDraw <noreply@agentdraw.io>';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log(`[email] No RESEND_API_KEY — logging email instead:`);
    console.log(`[email] To: ${opts.to} | Subject: ${opts.subject}`);
    console.log(`[email] Body: ${opts.text || '(html only)'}`);
    return true; // Don't block flows when email isn't configured
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[email] Resend API error: ${res.status} ${body}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[email] Send failed:`, err);
    return false;
  }
}
