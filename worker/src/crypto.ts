// JWT signing/verification (jose) + bcrypt password hashing
import { SignJWT, jwtVerify } from 'jose';
// @ts-expect-error bcryptjs has no types — add a local declaration
import bcrypt from 'bcryptjs';

const ALG = 'HS256';
const ISSUER = 'diernus-portal';
const TOKEN_TTL = '7d';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signJwt(payload: { sub: string; role: 'studio' | 'client' }, secret: string): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey(secret));
}

export async function verifyJwt(token: string, secret: string): Promise<{ sub: string; role: 'studio' | 'client' } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { issuer: ISSUER });
    if (typeof payload.sub !== 'string' || (payload.role !== 'studio' && payload.role !== 'client')) return null;
    return { sub: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

// Random URL-safe token for invitations
export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// UUID v4 for primary keys
export function uuid(): string {
  return crypto.randomUUID();
}
