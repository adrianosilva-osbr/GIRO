import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireAuth } from './auth.js';
import { ah, errorHandler } from './errors.js';
import { eventsHandler } from './events.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { projectsRouter } from './routes/projects.js';
import { commentsRouter, issuesRouter, workLogsRouter } from './routes/issues.js';
import { projectSprintsRouter, sprintsRouter } from './routes/sprints.js';
import { deleteAttachment, downloadAttachment, uploadAttachments } from './routes/attachments.js';
import { issueLinksRouter, linksRouter } from './routes/links.js';
import { notificationsRouter } from './routes/notifications.js';
import { projectReportsRouter, sprintReportsRouter } from './routes/reports.js';
import { projectConfigRouter } from './routes/config.js';
import { filtersRouter } from './routes/filters.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.get('/api/events', requireAuth, ah(eventsHandler));
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/projects/:key/sprints', requireAuth, projectSprintsRouter);
  app.use('/api/projects/:key', requireAuth, projectReportsRouter);
  app.use('/api/projects/:key', requireAuth, projectConfigRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.post('/api/issues/:key/attachments', requireAuth, ah(uploadAttachments));
  app.use('/api/issues/:key/links', requireAuth, issueLinksRouter);
  app.use('/api/issues', requireAuth, issuesRouter);
  app.use('/api/comments', requireAuth, commentsRouter);
  app.use('/api/worklogs', requireAuth, workLogsRouter);
  app.use('/api/sprints', requireAuth, sprintReportsRouter);
  app.use('/api/sprints', requireAuth, sprintsRouter);
  app.use('/api/links', requireAuth, linksRouter);
  app.use('/api/notifications', requireAuth, notificationsRouter);
  app.use('/api/filters', requireAuth, filtersRouter);
  // Authorized by a signed URL instead of the session (see signedUrl).
  app.get('/api/attachments/:id/file', ah(downloadAttachment));
  app.delete('/api/attachments/:id', requireAuth, ah(deleteAttachment));
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
