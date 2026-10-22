import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Logo } from '../components/Icons';
import { ErrorText, Field } from '../components/ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, login, register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <Logo /> <span>GIRO</span>
        </div>
        <h1>{mode === 'login' ? 'Entre para continuar' : 'Crie sua conta'}</h1>
        {mode === 'register' && (
          <Field label="Nome">
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </Field>
        )}
        <Field label="E-mail">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
        </Field>
        <Field label="Senha" hint={mode === 'register' ? 'Mínimo de 6 caracteres' : undefined}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </Field>
        <ErrorText error={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>
        <p className="auth-switch">
          {mode === 'login' ? (
            <>Não tem conta? <Link to="/register">Cadastre-se</Link></>
          ) : (
            <>Já tem conta? <Link to="/login">Entrar</Link></>
          )}
        </p>
        {mode === 'login' && (
          <p className="muted small auth-demo">Demo: ana@giro.dev / giro123</p>
        )}
      </form>
    </div>
  );
}
