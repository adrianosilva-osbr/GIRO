import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, publicUser, requireAuth, signToken } from '../auth.js';

export const AVATAR_COLORS = ['#0C66E4', '#1F845A', '#AE2E24', '#6E5DC6', '#C25100', '#206A83', '#943D73', '#5B7F24'];

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome'),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).optional(),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

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
    res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
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
    res.json({ token: signToken(user.id), user: publicUser(user) });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(currentUser(req)) });
});

authRouter.patch(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const data = profileSchema.parse(req.body);
    const user = await prisma.user.update({ where: { id: currentUser(req).id }, data });
    res.json({ user: publicUser(user) });
  }),
);
