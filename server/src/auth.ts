import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';
import { prisma } from './db.js';
import { HttpError } from './errors.js';

const SECRET = process.env.JWT_SECRET || 'giro-dev-secret';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** `v` is the user's tokenVersion; bumping it (password change/reset) revokes every older token. */
export function signToken(user: Pick<User, 'id' | 'tokenVersion'>) {
  return jwt.sign({ sub: user.id, v: user.tokenVersion }, SECRET, { expiresIn: '7d' });
}

export function publicUser(u: Pick<User, 'id' | 'name' | 'email' | 'avatarColor'>) {
  return { id: u.id, name: u.name, email: u.email, avatarColor: u.avatarColor };
}

/** What a user may see about their own account. */
export function selfUser(u: User) {
  return { ...publicUser(u), emailNotifications: u.emailNotifications };
}

export const userSelect = { id: true, name: true, email: true, avatarColor: true } as const;

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Não autenticado');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, SECRET) as jwt.JwtPayload;
    } catch {
      throw new HttpError(401, 'Sessão expirada, faça login novamente');
    }
    const user = await prisma.user.findUnique({ where: { id: String(payload.sub) } });
    if (!user) throw new HttpError(401, 'Usuário não encontrado');
    if ((payload.v ?? 0) !== user.tokenVersion) {
      throw new HttpError(401, 'Sua senha foi alterada, faça login novamente');
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** For handlers mounted behind requireAuth. */
export function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Não autenticado');
  return req.user;
}
