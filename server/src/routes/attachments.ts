import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import type { Attachment } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { assertMember, loadIssue } from '../access.js';
import { publishProject } from '../events.js';

export const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../uploads'),
);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;
const SECRET = process.env.JWT_SECRET || 'giro-dev-secret';

// Only these are shown inside the browser; everything else is forced to download, so an
// uploaded HTML/SVG file can never run script in the app's origin.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  defParamCharset: 'utf8',
});

function sign(id: string, exp: number) {
  return crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('hex').slice(0, 32);
}

/**
 * Download URLs carry a signature instead of the session token (img tags can't send headers).
 * The expiry is rounded to the hour so the URL stays stable across refetches and images don't reload.
 */
export function signedUrl(id: string) {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3600;
  return `/api/attachments/${id}/file?exp=${exp}&sig=${sign(id, exp)}`;
}

export function serializeAttachment<T extends Attachment>(a: T) {
  const { storageKey: _key, ...rest } = a;
  return { ...rest, url: signedUrl(a.id), isImage: a.mimeType.startsWith('image/') && INLINE_TYPES.has(a.mimeType) };
}

export function removeFiles(storageKeys: string[]) {
  for (const key of storageKeys) {
    fs.promises.unlink(path.join(UPLOAD_DIR, key)).catch(() => {});
  }
}

function runUpload(req: Request, res: Response) {
  return new Promise<void>((resolve, reject) => {
    upload.array('files', MAX_FILES)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'Cada arquivo pode ter no máximo 10 MB'));
        if (err.code === 'LIMIT_FILE_COUNT') return reject(new HttpError(400, `Envie no máximo ${MAX_FILES} arquivos por vez`));
        return reject(new HttpError(400, 'Falha no envio do arquivo'));
      }
      if (err) return reject(err);
      resolve();
    });
  });
}

/** POST /api/issues/:key/attachments (multipart, field "files") */
export async function uploadAttachments(req: Request, res: Response) {
  const user = currentUser(req);
  // Check access before anything is written to disk.
  const { issue } = await loadIssue(req.params.key, user.id);
  await runUpload(req, res);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, 'Nenhum arquivo enviado');

  const attachments = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const f of files) {
      created.push(
        await tx.attachment.create({
          data: {
            issueId: issue.id,
            uploaderId: user.id,
            filename: f.originalname.slice(0, 255),
            mimeType: f.mimetype || 'application/octet-stream',
            size: f.size,
            storageKey: f.filename,
          },
          include: { uploader: { select: userSelect } },
        }),
      );
    }
    await tx.activity.create({
      data: {
        issueId: issue.id,
        userId: user.id,
        action: 'updated',
        field: 'attachment',
        toValue: files.map((f) => f.originalname).join(', '),
      },
    });
    await tx.issue.update({ where: { id: issue.id }, data: { updatedAt: new Date() } });
    return created;
  });
  publishProject(issue.projectId);
  res.status(201).json({ attachments: attachments.map(serializeAttachment) });
}

/** GET /api/attachments/:id/file?exp&sig — public, authorized by the signature. */
export async function downloadAttachment(req: Request, res: Response) {
  const { id } = req.params;
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig ?? '');
  const expected = sign(id, exp);
  const valid =
    Number.isFinite(exp) &&
    exp * 1000 > Date.now() &&
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) throw new HttpError(403, 'Link de anexo inválido ou expirado');

  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment) throw new HttpError(404, 'Anexo não encontrado');
  const inline = INLINE_TYPES.has(attachment.mimeType) && req.query.download === undefined;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Chrome's PDF viewer refuses to run under a sandbox CSP; every other type gets the lockdown.
  if (attachment.mimeType !== 'application/pdf') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Type', inline ? attachment.mimeType : 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
  );
  res.sendFile(path.join(UPLOAD_DIR, attachment.storageKey), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Arquivo não encontrado no servidor' });
  });
}

/** DELETE /api/attachments/:id — the uploader or a project admin. */
export async function deleteAttachment(req: Request, res: Response) {
  const user = currentUser(req);
  const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id }, include: { issue: true } });
  if (!attachment) throw new HttpError(404, 'Anexo não encontrado');
  const membership = await assertMember(attachment.issue.projectId, user.id);
  if (attachment.uploaderId !== user.id && membership.role !== 'ADMIN') {
    throw new HttpError(403, 'Apenas quem enviou o anexo ou um administrador pode excluí-lo');
  }
  await prisma.$transaction([
    prisma.attachment.delete({ where: { id: attachment.id } }),
    prisma.activity.create({
      data: { issueId: attachment.issueId, userId: user.id, action: 'updated', field: 'attachment', fromValue: attachment.filename },
    }),
  ]);
  removeFiles([attachment.storageKey]);
  publishProject(attachment.issue.projectId);
  res.status(204).end();
}
