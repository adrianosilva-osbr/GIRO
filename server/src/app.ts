import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireAuth } from './auth.js';
import { errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { projectsRouter } from './routes/projects.js';
import { commentsRouter, issuesRouter } from './routes/issues.js';
import { projectSprintsRouter, sprintsRouter } from './routes/sprints.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/projects/:key/sprints', requireAuth, projectSprintsRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/issues', requireAuth, issuesRouter);
  app.use('/api/comments', requireAuth, commentsRouter);
  app.use('/api/sprints', requireAuth, sprintsRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

  // In production the API also serves the built frontend.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
