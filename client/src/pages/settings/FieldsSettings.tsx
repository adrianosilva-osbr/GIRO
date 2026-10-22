import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { CustomField, FieldType, Project } from '../../types';
import { Icon } from '../../components/Icons';
import { ErrorText } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { BlurField } from './WorkflowSettings';

const TYPE_LABEL: Record<FieldType, string> = {
  TEXT: 'Texto',
  NUMBER: 'Número',
  DATE: 'Data',
  SELECT: 'Lista de opções',
};

export function FieldsSettings({ project, isAdmin }: { project: Project; isAdmin: boolean }) {
  const fields = project.customFields ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('TEXT');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<unknown>(null);
  const base = `/projects/${project.key}/fields`;

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await fn();
      await Promise.all([qc.invalidateQueries({ queryKey: ['project', project.key] }), qc.invalidateQueries({ queryKey: ['issue'] })]);
      toast(success);
    } catch (err) {
      setError(err);
    }
  };
  const parseOptions = (s: string) => s.split(/[\n,]/).map((o) => o.trim()).filter(Boolean);

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api(base, { method: 'POST', body: { name, type, options: parseOptions(options) } });
      setName('');
      setOptions('');
    }, 'Campo criado');
  };

  return (
    <section className="settings-section">
      <h2>Campos personalizados</h2>
      <p className="muted">
        Campos extras aparecem no painel de detalhes de todas as issues do projeto e podem ser usados na busca JQL pelo nome,
        por exemplo <code>"Ambiente" = Produção</code>.
      </p>
      <ErrorText error={error} />
      {fields.length === 0 ? (
        <p className="muted">Nenhum campo personalizado ainda.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Nome</th><th>Tipo</th><th>Opções</th><th /></tr></thead>
          <tbody>
            {fields.map((f: CustomField) => (
              <tr key={f.id}>
                <td>
                  <BlurField value={f.name} disabled={!isAdmin} onSave={(v) => run(() => api(`${base}/${f.id}`, { method: 'PATCH', body: { name: v } }), 'Campo renomeado')} />
                </td>
                <td>{TYPE_LABEL[f.type]}</td>
                <td>
                  {f.type === 'SELECT' ? (
                    <BlurField
                      value={f.options.join(', ')}
                      disabled={!isAdmin}
                      onSave={(v) => run(() => api(`${base}/${f.id}`, { method: 'PATCH', body: { options: parseOptions(v) } }), 'Opções atualizadas')}
                    />
                  ) : <span className="muted">—</span>}
                </td>
                <td className="right">
                  {isAdmin && (
                    <button
                      className="btn-icon"
                      title="Excluir campo"
                      onClick={() => confirm(`Excluir o campo "${f.name}"? Os valores preenchidos em todas as issues serão apagados.`) &&
                        run(() => api(`${base}/${f.id}`, { method: 'DELETE' }), 'Campo excluído')}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isAdmin && (
        <form className="form mt-sm field-form" onSubmit={add}>
          <div className="row gap-sm">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do campo (ex.: Ambiente)" required />
            <select value={type} onChange={(e) => setType(e.target.value as FieldType)} style={{ width: 180 }}>
              {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <button className="btn btn-primary">Criar campo</button>
          </div>
          {type === 'SELECT' && (
            <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Opções separadas por vírgula (ex.: Produção, Homologação)" required />
          )}
        </form>
      )}
    </section>
  );
}
