import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { getUserAuthState } from './crmDb';

export interface CrmUser {
  userId: string;
  email?: string;
  userType?: string;
  subRole?: string;
  role?: string;
  tokenVersion?: string;
}

/** True when CRM SSO is active (a shared JWT secret is configured). */
export function ssoEnabled(): boolean {
  return !!config.jwtSecret;
}

/**
 * Is this user a WhatsApp "device admin" — allowed to connect/scan the QR and
 * log the session out? Configured via WPP_ADMIN_EMAILS; falls back to the CRM
 * superadmin role when no allow-list is set.
 */
export function isAdminUser(user: CrmUser | null | undefined): boolean {
  if (!user) return false;
  if (config.adminEmails.length > 0) {
    return !!user.email && config.adminEmails.includes(user.email.toLowerCase());
  }
  return user.role === 'superadmin';
}

/** Verify a CRM-issued JWT (the `crm_token` cookie or a bearer) with the shared secret. */
export function verifyCrmToken(token: string | undefined): CrmUser | null {
  if (!token || !config.jwtSecret) return null;
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as Record<
      string,
      unknown
    >;
    if (!decoded?.userId) return null;
    return {
      userId: String(decoded.userId),
      email: decoded.email as string | undefined,
      userType: decoded.userType as string | undefined,
      subRole: decoded.subRole as string | undefined,
      role: decoded.role as string | undefined,
      tokenVersion: decoded.tokenVersion as string | undefined,
    };
  } catch {
    return null;
  }
}

/** Extract the token from a request: `crm_token` cookie first, then Authorization: Bearer. */
export function tokenFromRequest(req: Request): string | undefined {
  const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.crm_token;
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

/** Pull a named cookie value out of a raw Cookie header (used for the socket handshake). */
export function cookieFromHeader(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

/**
 * Verify a token AND re-check live revocation state against the CRM DB.
 * Returns the user if the login is valid and NOT revoked (disabled / deleted /
 * tokenVersion bumped by a CRM logout or password reset). Fails open only when
 * the DB itself is unreachable (the JWT is still cryptographically valid).
 */
export async function authenticateToken(token: string | undefined): Promise<CrmUser | null> {
  const user = verifyCrmToken(token);
  if (!user) return null;
  const dbState = await getUserAuthState(user.userId, user.role === 'superadmin');
  if (dbState) {
    if (!dbState.exists || dbState.isDisabled) return null;
    if (String(dbState.tokenVersion) !== String(user.tokenVersion ?? '0')) return null;
  }
  return user;
}

/**
 * Unified auth gate for the REST API.
 *  - CRM SSO configured (JWT_SECRET set) -> require a valid, non-revoked CRM login.
 *  - else API_KEY set                    -> require the shared key (legacy).
 *  - else                                -> open (local dev with no auth).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (config.jwtSecret) {
    const user = await authenticateToken(tokenFromRequest(req));
    if (!user) {
      res.status(401).json({ error: 'Not authenticated', login: true });
      return;
    }
    (req as unknown as { crmUser?: CrmUser }).crmUser = user;
    next();
    return;
  }
  if (config.apiKey) {
    const provided = req.header('x-api-key') ?? (req.query.apiKey as string | undefined);
    if (provided !== config.apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  next();
}
