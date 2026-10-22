import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Logo } from '../components/Icons';
import { ErrorText, Field } from '../components/ui';

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo /> <span>GIRO</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Esqueceu a senha?">
      {sent ? (
        <>
          <p>
            Se existir uma conta com <b>{email}</b>, enviamos um link para redefinir a senha. O link vale por 1 hora.
          </p>
          <p className="auth-switch"><Link to="/login">Voltar para o login</Link></p>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          <p className="muted">Informe seu e-mail e enviaremos um link para você criar uma nova senha.</p>
          <Field label="E-mail">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
          </Field>
          <ErrorText error={error} />
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Enviando…' : 'Enviar link'}</button>
          <p className="auth-switch"><Link to="/login">Voltar para o login</Link></p>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(new Error('As senhas não conferem'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthCard title="Link inválido">
        <p>Este link de redefinição está incompleto.</p>
        <p className="auth-switch"><Link to="/forgot-password">Pedir um novo link</Link></p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Criar nova senha">
      {done ? (
        <>
          <p>Senha alterada com sucesso. Sessões abertas em outros dispositivos foram encerradas.</p>
          <Link className="btn btn-primary btn-block" to="/login">Entrar</Link>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          <Field label="Nova senha" hint="Mínimo de 6 caracteres">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={6} autoFocus />
          </Field>
          <Field label="Confirmar nova senha">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
          <ErrorText error={error} />
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
          <p className="auth-switch"><Link to="/forgot-password">Pedir um novo link</Link></p>
        </form>
      )}
    </AuthCard>
  );
}
