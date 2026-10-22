import nodemailer, { type Transporter } from 'nodemailer';

export const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Last messages sent, kept in memory so tests (and debugging) can inspect them. */
export const outbox: Mail[] = [];

let transport: Transporter | null | undefined;

function getTransport() {
  if (transport !== undefined) return transport;
  const host = process.env.SMTP_HOST;
  if (!host) return (transport = null);
  const port = Number(process.env.SMTP_PORT) || 587;
  transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

/** Sends an e-mail through SMTP, or prints it to the console when SMTP is not configured. Never throws. */
export async function sendMail(mail: Mail) {
  outbox.push(mail);
  if (outbox.length > 50) outbox.shift();
  const t = getTransport();
  if (!t) {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`\n[e-mail] Para: ${mail.to}\n[e-mail] Assunto: ${mail.subject}\n${mail.text}\n`);
    }
    return;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || 'GIRO <no-reply@giro.local>', ...mail });
  } catch (err) {
    console.error('Falha ao enviar e-mail:', err);
  }
}
