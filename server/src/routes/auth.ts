import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, requireAuth, selfUser, signToken } from '../auth.js';
import { APP_URL, sendMail } from '../mailer.js';

export const AVATAR_COLORS = ['#0C66E4', '#1F845A', '#AE2E24', '#6E5DC6', '#C25100', '#206A83', '#943D73', '#5B7F24'];

const password = z.string().min(6, 'A senha deve ter pelo menos 6 caracteres');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome'),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).optional(),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  emailNotifications: z.boolean().optional(),
});

const changePasswordSchema = z.object({ currentPassword: z.string(), newPassword: password });
const forgotSchema = z.object({ email: z.string().trim().toLowerCase() });
const resetSchema = z.object({ token: z.string().min(1), password });

const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_RESETS_PER_HOUR = 3;
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const authRouter = Router();

authRouter.post(
  '/register',
  ah(async (req, res) => {
    const data = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw new HttpError(409, 'Já existe uma conta com este e-mail');
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash: await bcrypt.hash(data.password, 10),
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      },
    });
    res.status(201).json({ token: signToken(user), user: selfUser(user) });
  }),
);

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const data = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: data.email } });
    if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) {
      throw new HttpError(401, 'E-mail ou senha inválidos');
    }
    res.json({ token: signToken(user), user: selfUser(user) });
  }),
);

/** Always answers the same way, so it can't be used to find out which e-mails have accounts. */
authRouter.post(
  '/forgot-password',
  ah(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.isSystem) {
      const recent = await prisma.passwordResetToken.count({
        where: { userId: user.id, createdAt: { gt: new Date(Date.now() - RESET_TTL_MS) } },
      });
      if (recent < MAX_RESETS_PER_HOUR) {
        const token = crypto.randomBytes(32).toString('hex');
        await prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
        });
        void sendMail({
          to: user.email,
          subject: 'Redefinição de senha do GIRO',
          text:
            `Olá, ${user.name}.\n\nRecebemos um pedido para redefinir sua senha. Use o link abaixo em até 1 hora:\n\n` +
            `${APP_URL}/reset-password?token=${token}\n\nSe não foi você, ignore este e-mail; sua senha continua a mesma.`,
        });
      }
    }
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/reset-password',
  ah(async (req, res) => {
    const data = resetSchema.parse(req.body);
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(data.token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new HttpError(400, 'Link inválido ou expirado. Peça um novo link de redefinição.');
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await bcrypt.hash(data.password, 10), tokenVersion: { increment: 1 } },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.deleteMany({ where: { userId: record.userId, usedAt: null } }),
    ]);
    res.json({ ok: true });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: selfUser(currentUser(req)) });
});

authRouter.patch(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const data = profileSchema.parse(req.body);
    const user = await prisma.user.update({ where: { id: currentUser(req).id }, data });
    res.json({ user: selfUser(user) });
  }),
);

/** Changing the password signs out every other session; the caller gets a fresh token. */
authRouter.post(
  '/change-password',
  requireAuth,
  ah(async (req, res) => {
    const me = currentUser(req);
    const data = changePasswordSchema.parse(req.body);
    if (!(await bcrypt.compare(data.currentPassword, me.passwordHash))) {
      throw new HttpError(400, 'A senha atual está incorreta');
    }
    const updated = await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: await bcrypt.hash(data.newPassword, 10), tokenVersion: { increment: 1 } },
    });
    res.json({ token: signToken(updated) });
  }),
);
