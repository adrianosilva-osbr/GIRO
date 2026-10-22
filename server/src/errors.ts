import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Express 4 does not forward rejected promises to the error handler; this wrapper does. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.');
    return res.status(400).json({
      error: field ? `Campo inválido: ${field} — ${first.message}` : 'Dados inválidos',
      issues: err.issues,
    });
  }
  console.error(err);
  return res.status(500).json({ error: 'Erro interno do servidor' });
}
