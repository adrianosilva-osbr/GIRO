import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth, useMe } from '../auth';
import type { Me } from '../types';
import { Avatar, ErrorText, Field } from '../components/ui';
import { useToast } from '../components/Toast';

const COLORS = ['#0C66E4', '#1F845A', '#AE2E24', '#6E5DC6', '#C25100', '#206A83', '#943D73', '#5B7F24'];

export function ProfilePage() {
  const me = useMe();
  const { setUser, replaceToken } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me.name);
  const [avatarColor, setAvatarColor] = useState(me.avatarColor);
  const [profileError, setProfileError] = useState<unknown>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [passwordError, setPasswordError] = useState<unknown>(null);

  const saveProfile = async (patch: Partial<Me>) => {
    setProfileError(null);
    try {
      const { user } = await api<{ user: Me }>('/auth/me', { method: 'PATCH', body: patch });
      setUser(user);
      toast('Preferências salvas');
    } catch (err) {
      setProfileError(err);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    if (next !== confirmNext) {
      setPasswordError(new Error('A confirmação não confere com a nova senha'));
      return;
    }
    try {
      const { token } = await api<{ token: string }>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      replaceToken(token);
      setCurrent('');
      setNext('');
      setConfirmNext('');
      toast('Senha alterada. Outras sessões foram desconectadas.');
    } catch (err) {
      setPasswordError(err);
    }
  };

  return (
    <div className="page narrow">
      <h1 className="page-title">Perfil e preferências</h1>

      <section className="settings-section">
        <h2>Perfil</h2>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            saveProfile({ name, avatarColor });
          }}
        >
          <div className="row gap-sm">
            <Avatar user={{ ...me, name, avatarColor }} size={56} />
            <div className="muted">{me.email}</div>
          </div>
          <Field label="Nome">
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </Field>
          <div className="field">
            <span className="field-label">Cor do avatar</span>
            <div className="color-picker">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === avatarColor ? 'selected' : ''}
                  style={{ background: c }}
                  onClick={() => setAvatarColor(c)}
                  aria-label={`Cor ${c}`}
                />
              ))}
            </div>
          </div>
          <ErrorText error={profileError} />
          <div><button className="btn btn-primary">Salvar perfil</button></div>
        </form>
      </section>

      <section className="settings-section">
        <h2>Notificações</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={me.emailNotifications}
            onChange={(e) => saveProfile({ emailNotifications: e.target.checked })}
          />
          Receber notificações por e-mail
        </label>
        <p className="muted small">
          Você recebe notificações quando alguém atribui uma issue a você, menciona você, ou comenta e muda o status de issues
          que você observa. Elas sempre aparecem no sino do topo da tela; esta opção controla apenas os e-mails.
        </p>
      </section>

      <section className="settings-section">
        <h2>Alterar senha</h2>
        <form className="form" onSubmit={changePassword}>
          <Field label="Senha atual">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <div className="form-row">
            <Field label="Nova senha" hint="Mínimo de 6 caracteres">
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={6} />
            </Field>
            <Field label="Confirmar nova senha">
              <input type="password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} autoComplete="new-password" required />
            </Field>
          </div>
          <ErrorText error={passwordError} />
          <div><button className="btn btn-primary">Alterar senha</button></div>
        </form>
      </section>
    </div>
  );
}
