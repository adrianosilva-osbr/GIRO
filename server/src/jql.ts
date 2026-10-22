import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { normalize } from './workflow.js';

/*
 * A practical subset of Jira's JQL:
 *
 *   project = LOJA AND status IN ("Em andamento", "Em revisão") AND assignee = currentUser()
 *   type = Bug AND priority >= Alta AND created >= -7d ORDER BY priority DESC, created
 *   text ~ "pagamento" OR labels IS EMPTY
 *   "Cliente" = "ACME"            (custom fields by name, in quotes)
 *
 * Field names and values accept English (Jira) and Portuguese spellings.
 */

export class JqlError extends Error {
  constructor(message: string, public position: number) {
    super(message);
  }
}

// ---------------------------------------------------------------- tokenizer

type TokenType = 'word' | 'string' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPS = ['!=', '>=', '<=', '!~', '=', '>', '<', '~'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') tokens.push({ type: 'lparen', value: c, pos: i++ });
    else if (c === ')') tokens.push({ type: 'rparen', value: c, pos: i++ });
    else if (c === ',') tokens.push({ type: 'comma', value: c, pos: i++ });
    else if (c === '"' || c === "'") {
      const start = i++;
      let value = '';
      while (i < input.length && input[i] !== c) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        value += input[i++];
      }
      if (i >= input.length) throw new JqlError('Texto entre aspas não foi fechado', start);
      i++;
      tokens.push({ type: 'string', value, pos: start });
    } else {
      const op = OPS.find((o) => input.startsWith(o, i));
      if (op) {
        tokens.push({ type: 'op', value: op, pos: i });
        i += op.length;
      } else {
        const start = i;
        while (i < input.length && !/[\s(),"'=!<>~]/.test(input[i])) i++;
        if (i === start) throw new JqlError(`Caractere inesperado "${c}"`, i);
        tokens.push({ type: 'word', value: input.slice(start, i), pos: start });
      }
    }
  }
  tokens.push({ type: 'eof', value: '', pos: input.length });
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface Value {
  text: string;
  /** Bare word or quoted string; functions are words ending in "()" */
  quoted: boolean;
  fn?: string;
  pos: number;
}
export type Node =
  | { kind: 'and' | 'or'; items: Node[] }
  | { kind: 'not'; item: Node }
  | { kind: 'clause'; field: string; op: string; values: Value[]; pos: number };
export interface OrderItem {
  field: string;
  dir: 'asc' | 'desc';
  pos: number;
}
export interface Parsed {
  where: Node | null;
  orderBy: OrderItem[];
}

const kw = (t: Token, word: string) => t.type === 'word' && t.value.toUpperCase() === word;

export function parseJql(input: string): Parsed {
  const tokens = tokenize(input);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const expect = (type: TokenType, what: string) => {
    const t = next();
    if (t.type !== type) throw new JqlError(`Esperava ${what}`, t.pos);
    return t;
  };

  function value(): Value {
    const t = next();
    if (t.type === 'string') return { text: t.value, quoted: true, pos: t.pos };
    if (t.type !== 'word') throw new JqlError('Esperava um valor', t.pos);
    if (peek().type === 'lparen') {
      next();
      expect('rparen', '")" (funções não recebem argumentos)');
      return { text: t.value, quoted: false, fn: t.value.toLowerCase(), pos: t.pos };
    }
    return { text: t.value, quoted: false, pos: t.pos };
  }

  function clause(): Node {
    const f = next();
    if (f.type !== 'word' && f.type !== 'string') throw new JqlError('Esperava o nome de um campo', f.pos);
    const field = f.value;
    const t = peek();
    if (kw(t, 'IS')) {
      next();
      const negate = kw(peek(), 'NOT');
      if (negate) next();
      const e = next();
      if (!kw(e, 'EMPTY') && !kw(e, 'NULL')) throw new JqlError('Esperava EMPTY depois de IS', e.pos);
      return { kind: 'clause', field, op: negate ? 'is not empty' : 'is empty', values: [], pos: f.pos };
    }
    let op: string;
    if (kw(t, 'NOT')) {
      next();
      if (!kw(next(), 'IN')) throw new JqlError('Esperava IN depois de NOT', t.pos);
      op = 'not in';
    } else if (kw(t, 'IN')) {
      next();
      op = 'in';
    } else if (t.type === 'op') {
      op = next().value;
    } else {
      throw new JqlError(`Esperava um operador depois de "${field}" (=, !=, >, <, ~, IN, IS)`, t.pos);
    }
    if (op === 'in' || op === 'not in') {
      expect('lparen', '"(" depois de IN');
      const values = [value()];
      while (peek().type === 'comma') {
        next();
        values.push(value());
      }
      expect('rparen', '")" para fechar a lista');
      return { kind: 'clause', field, op, values, pos: f.pos };
    }
    if (kw(peek(), 'EMPTY') || kw(peek(), 'NULL')) {
      const e = next();
      if (op !== '=' && op !== '!=') throw new JqlError('EMPTY só pode ser usado com =, != ou IS', e.pos);
      return { kind: 'clause', field, op: op === '=' ? 'is empty' : 'is not empty', values: [], pos: f.pos };
    }
    return { kind: 'clause', field, op, values: [value()], pos: f.pos };
  }

  function unary(): Node {
    if (kw(peek(), 'NOT')) {
      next();
      return { kind: 'not', item: unary() };
    }
    if (peek().type === 'lparen') {
      next();
      const inner = or();
      expect('rparen', '")"');
      return inner;
    }
    return clause();
  }

  function and(): Node {
    const items = [unary()];
    while (kw(peek(), 'AND')) {
      next();
      items.push(unary());
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  function or(): Node {
    const items = [and()];
    while (kw(peek(), 'OR')) {
      next();
      items.push(and());
    }
    return items.length === 1 ? items[0] : { kind: 'or', items };
  }

  let where: Node | null = null;
  if (peek().type !== 'eof' && !kw(peek(), 'ORDER')) where = or();
  const orderBy: OrderItem[] = [];
  if (kw(peek(), 'ORDER')) {
    next();
    if (!kw(next(), 'BY')) throw new JqlError('Esperava BY depois de ORDER', peek().pos);
    do {
      const f = next();
      if (f.type !== 'word' && f.type !== 'string') throw new JqlError('Esperava um campo para ordenar', f.pos);
      let dir: 'asc' | 'desc' = 'asc';
      if (kw(peek(), 'ASC') || kw(peek(), 'DESC')) dir = next().value.toLowerCase() as 'asc' | 'desc';
      orderBy.push({ field: f.value, dir, pos: f.pos });
    } while (peek().type === 'comma' && next());
  }
  if (peek().type !== 'eof') throw new JqlError(`Trecho inesperado "${peek().value}" (faltou AND/OR?)`, peek().pos);
  return { where, orderBy };
}

// ---------------------------------------------------------------- field vocabulary

const FIELD_ALIASES: Record<string, string> = {
  project: 'project', projeto: 'project',
  key: 'key', issuekey: 'key', chave: 'key', issue: 'key',
  type: 'type', issuetype: 'type', tipo: 'type',
  status: 'status', situacao: 'status',
  statuscategory: 'category', category: 'category', categoria: 'category',
  priority: 'priority', prioridade: 'priority',
  assignee: 'assignee', responsavel: 'assignee',
  reporter: 'reporter', relator: 'reporter',
  watcher: 'watcher', observador: 'watcher',
  sprint: 'sprint',
  epic: 'parent', 'epic link': 'parent', parent: 'parent', pai: 'parent', epico: 'parent',
  labels: 'labels', label: 'labels', etiqueta: 'labels', etiquetas: 'labels',
  text: 'text', texto: 'text',
  summary: 'summary', resumo: 'summary', titulo: 'summary',
  description: 'description', descricao: 'description',
  created: 'created', criado: 'created', createddate: 'created',
  updated: 'updated', atualizado: 'updated', updateddate: 'updated',
  resolved: 'resolved', resolutiondate: 'resolved', resolvido: 'resolved', concluido: 'resolved',
  due: 'due', duedate: 'due', prazo: 'due', 'data limite': 'due',
  start: 'start', startdate: 'start', inicio: 'start', 'data de inicio': 'start',
  storypoints: 'points', 'story points': 'points', points: 'points', pontos: 'points',
};

const TYPE_VALUES: Record<string, string> = {
  epic: 'EPIC', epico: 'EPIC',
  story: 'STORY', historia: 'STORY',
  task: 'TASK', tarefa: 'TASK',
  bug: 'BUG', defeito: 'BUG',
  subtask: 'SUBTASK', 'sub-task': 'SUBTASK', subtarefa: 'SUBTASK',
};
const PRIORITY_ORDER = ['LOWEST', 'LOW', 'MEDIUM', 'HIGH', 'HIGHEST'];
const PRIORITY_VALUES: Record<string, string> = {
  highest: 'HIGHEST', 'muito alta': 'HIGHEST', critica: 'HIGHEST',
  high: 'HIGH', alta: 'HIGH',
  medium: 'MEDIUM', media: 'MEDIUM', normal: 'MEDIUM',
  low: 'LOW', baixa: 'LOW',
  lowest: 'LOWEST', 'muito baixa': 'LOWEST',
};
const CATEGORY_VALUES: Record<string, string> = {
  todo: 'TODO', 'to do': 'TODO', 'a fazer': 'TODO', new: 'TODO',
  in_progress: 'IN_PROGRESS', 'in progress': 'IN_PROGRESS', 'em andamento': 'IN_PROGRESS', indeterminate: 'IN_PROGRESS',
  done: 'DONE', concluido: 'DONE', complete: 'DONE',
};

export const JQL_FIELDS = [
  'project', 'key', 'type', 'status', 'statusCategory', 'priority', 'assignee', 'reporter', 'watcher', 'sprint',
  'epic', 'labels', 'text', 'summary', 'description', 'created', 'updated', 'resolved', 'due', 'start', 'storyPoints',
];

// ---------------------------------------------------------------- compiler

const DAY = 86_400_000;

interface Ctx {
  userId: string;
  projectIds: string[];
}

function lookup(map: Record<string, string>, v: Value, what: string) {
  const code = map[normalize(v.text)] ?? (Object.values(map).includes(v.text.toUpperCase()) ? v.text.toUpperCase() : undefined);
  if (!code) throw new JqlError(`${what} desconhecido(a): "${v.text}"`, v.pos);
  return code;
}

function parseDate(v: Value): { from: Date; to: Date } {
  const now = new Date();
  const dayRange = (d: Date) => {
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return { from, to: new Date(from.getTime() + DAY) };
  };
  if (v.fn) {
    const f = v.fn;
    if (f === 'now') return { from: now, to: now };
    if (f === 'startofday' || f === 'today') return dayRange(now);
    if (f === 'endofday') {
      const r = dayRange(now);
      return { from: r.to, to: r.to };
    }
    if (f === 'startofweek') {
      const d = dayRange(now).from;
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return { from: d, to: d };
    }
    if (f === 'startofmonth') {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d, to: d };
    }
    throw new JqlError(`Função de data desconhecida: ${v.text}()`, v.pos);
  }
  const rel = v.text.match(/^([+-]?\d+)\s*([dwhm])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { d: DAY, w: 7 * DAY, h: 3_600_000, m: 60_000 }[rel[2].toLowerCase() as 'd' | 'w' | 'h' | 'm'];
    const t = new Date(now.getTime() + n * unit);
    return { from: t, to: t };
  }
  const abs = v.text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (abs) return dayRange(new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])));
  throw new JqlError(`Data inválida: "${v.text}" (use AAAA-MM-DD, -7d, -2w ou startOfDay())`, v.pos);
}

type Where = Prisma.IssueWhereInput;

export async function compileJql(parsed: Parsed, ctx: Ctx): Promise<{ where: Where; orderBy: Prisma.IssueOrderByWithRelationInput[]; sortByPriority?: 'asc' | 'desc' }> {
  // Lookups the clauses may need, loaded once.
  const [statuses, users, customFields] = await Promise.all([
    prisma.projectStatus.findMany({ where: { projectId: { in: ctx.projectIds } } }),
    prisma.user.findMany({ where: { isSystem: false }, select: { id: true, name: true, email: true } }),
    prisma.customField.findMany({ where: { projectId: { in: ctx.projectIds } } }),
  ]);

  const userIds = (v: Value): (string | null)[] => {
    if (v.fn === 'currentuser') return [ctx.userId];
    if (v.fn) throw new JqlError(`Função desconhecida: ${v.text}()`, v.pos);
    const n = normalize(v.text);
    if (n === 'unassigned' || n === 'nao atribuido') return [null];
    const found = users.filter((u) => u.id === v.text || normalize(u.email) === n || normalize(u.name) === n);
    if (!found.length) {
      const partial = users.filter((u) => normalize(u.name).split(/\s+/).includes(n));
      if (partial.length === 1) return [partial[0].id];
      throw new JqlError(`Usuário não encontrado: "${v.text}"`, v.pos);
    }
    return found.map((u) => u.id);
  };

  const membership = (field: string, values: Value[], neg: boolean, map: (v: Value) => Where): Where => {
    const any: Where = values.length === 1 ? map(values[0]) : { OR: values.map(map) };
    return neg ? { NOT: any } : any;
  };

  const dateClause = (col: 'createdAt' | 'updatedAt' | 'resolvedAt' | 'dueDate' | 'startDate', op: string, values: Value[], pos: number): Where => {
    if (op === 'is empty') return { [col]: null };
    if (op === 'is not empty') return { NOT: { [col]: null } };
    if (op === 'in' || op === 'not in' || op === '~' || op === '!~') throw new JqlError('Datas aceitam =, !=, >, >=, <, <=', pos);
    const { from, to } = parseDate(values[0]);
    const exactDay = values[0].text.match(/^\d{4}/) || values[0].fn === 'startofday' || values[0].fn === 'today';
    switch (op) {
      case '=':
        return exactDay ? { [col]: { gte: from, lt: to } } : { [col]: from };
      case '!=':
        return exactDay ? { NOT: { [col]: { gte: from, lt: to } } } : { NOT: { [col]: from } };
      case '>':
        return { [col]: { gte: exactDay ? to : from } };
      case '>=':
        return { [col]: { gte: from } };
      case '<':
        return { [col]: { lt: from } };
      default:
        return { [col]: { lt: exactDay ? to : from } };
    }
  };

  const textOnly = (op: string, pos: number) => {
    if (op !== '~' && op !== '!~') throw new JqlError('Campos de texto usam ~ (contém) ou !~ (não contém)', pos);
  };

  async function clause(c: Extract<Node, { kind: 'clause' }>): Promise<Where> {
    const { op, values, pos } = c;
    const neg = op === '!=' || op === 'not in' || op === '!~';
    const eqLike = ['=', '!=', 'in', 'not in'].includes(op);
    const field = FIELD_ALIASES[normalize(c.field)];

    if (!field) {
      // Custom field, matched by name in the viewer's projects.
      const fields = customFields.filter((f) => normalize(f.name) === normalize(c.field));
      if (!fields.length) throw new JqlError(`Campo desconhecido: "${c.field}"`, pos);
      const ids = fields.map((f) => f.id);
      if (op === 'is empty') return { NOT: { customValues: { some: { fieldId: { in: ids } } } } };
      if (op === 'is not empty') return { customValues: { some: { fieldId: { in: ids } } } };
      if (op === '~' || op === '!~') {
        const w: Where = { customValues: { some: { fieldId: { in: ids }, value: { contains: values[0].text } } } };
        return op === '!~' ? { NOT: w } : w;
      }
      if (!eqLike) throw new JqlError('Campos personalizados aceitam =, !=, IN, ~ e IS EMPTY', pos);
      const canon = (v: Value) => {
        const isNumber = fields.some((f) => f.type === 'NUMBER') && Number.isFinite(Number(v.text));
        return isNumber ? String(Number(v.text)) : v.text;
      };
      return membership(c.field, values, neg, (v) => ({ customValues: { some: { fieldId: { in: ids }, value: canon(v) } } }));
    }

    const empty = (w: Where) => (op === 'is empty' ? w : { NOT: w });
    switch (field) {
      case 'project': {
        if (!eqLike) throw new JqlError('project aceita = , != e IN', pos);
        const projects = await prisma.project.findMany({ where: { id: { in: ctx.projectIds } }, select: { id: true, key: true, name: true } });
        return membership(field, values, neg, (v) => {
          const p = projects.find((x) => x.key === v.text.toUpperCase() || normalize(x.name) === normalize(v.text));
          if (!p) throw new JqlError(`Projeto não encontrado: "${v.text}"`, v.pos);
          return { projectId: p.id };
        });
      }
      case 'key':
        if (!eqLike) throw new JqlError('key aceita =, != e IN', pos);
        return membership(field, values, neg, (v) => ({ key: v.text.toUpperCase() }));
      case 'type':
        if (!eqLike) throw new JqlError('type aceita =, != e IN', pos);
        return membership(field, values, neg, (v) => ({ type: lookup(TYPE_VALUES, v, 'Tipo') }));
      case 'status': {
        if (!eqLike) throw new JqlError('status aceita =, != e IN', pos);
        return membership(field, values, neg, (v) => {
          const matches = statuses.filter((s) => s.key === v.text.toUpperCase() || normalize(s.name) === normalize(v.text));
          if (!matches.length) throw new JqlError(`Status desconhecido: "${v.text}"`, v.pos);
          return { OR: matches.map((s) => ({ projectId: s.projectId, status: s.key })) };
        });
      }
      case 'category':
        if (!eqLike) throw new JqlError('statusCategory aceita =, != e IN', pos);
        return membership(field, values, neg, (v) => ({ statusRef: { category: lookup(CATEGORY_VALUES, v, 'Categoria') } }));
      case 'priority': {
        const code = (v: Value) => lookup(PRIORITY_VALUES, v, 'Prioridade');
        if (eqLike) return membership(field, values, neg, (v) => ({ priority: code(v) }));
        if (!['>', '>=', '<', '<='].includes(op)) throw new JqlError('priority aceita =, !=, IN, >, >=, <, <=', pos);
        const idx = PRIORITY_ORDER.indexOf(code(values[0]));
        const keep = PRIORITY_ORDER.filter((_, i) => (op === '>' ? i > idx : op === '>=' ? i >= idx : op === '<' ? i < idx : i <= idx));
        return { priority: { in: keep } };
      }
      case 'assignee':
      case 'reporter': {
        const col = field === 'assignee' ? 'assigneeId' : 'reporterId';
        if (op === 'is empty' || op === 'is not empty') return empty({ [col]: null });
        if (!eqLike) throw new JqlError(`${c.field} aceita =, !=, IN e IS EMPTY`, pos);
        return membership(field, values, neg, (v) => {
          const ids = userIds(v);
          return ids.length === 1 ? { [col]: ids[0] } : { OR: ids.map((id) => ({ [col]: id })) };
        });
      }
      case 'watcher':
        if (!eqLike) throw new JqlError('watcher aceita = e IN', pos);
        return membership(field, values, neg, (v) => ({ watchers: { some: { userId: { in: userIds(v).filter((x): x is string => !!x) } } } }));
      case 'sprint': {
        if (op === 'is empty' || op === 'is not empty') return empty({ sprintId: null });
        if (!eqLike) throw new JqlError('sprint aceita =, !=, IN e IS EMPTY', pos);
        return membership(field, values, neg, (v) => {
          if (v.fn === 'opensprints') return { sprint: { status: { not: 'CLOSED' } } };
          if (v.fn === 'closedsprints') return { sprint: { status: 'CLOSED' } };
          if (v.fn === 'activesprint' || v.fn === 'activesprints') return { sprint: { status: 'ACTIVE' } };
          if (v.fn) throw new JqlError(`Função desconhecida: ${v.text}()`, v.pos);
          return { OR: [{ sprintId: v.text }, { sprint: { name: v.text } }] };
        });
      }
      case 'parent':
        if (op === 'is empty' || op === 'is not empty') return empty({ parentId: null });
        if (!eqLike) throw new JqlError(`${c.field} aceita =, !=, IN e IS EMPTY`, pos);
        return membership(field, values, neg, (v) => ({ parent: { key: v.text.toUpperCase() } }));
      case 'labels':
        if (op === 'is empty' || op === 'is not empty') return empty({ labels: '' });
        if (!eqLike) throw new JqlError('labels aceita =, !=, IN e IS EMPTY', pos);
        return membership(field, values, neg, (v) => ({ labels: { contains: `,${normalize(v.text).replace(/[\s,]+/g, '-')},` } }));
      case 'text':
      case 'summary':
      case 'description': {
        textOnly(op, pos);
        const t = values[0].text;
        const w: Where =
          field === 'summary'
            ? { title: { contains: t } }
            : field === 'description'
              ? { description: { contains: t } }
              : { OR: [{ title: { contains: t } }, { description: { contains: t } }, { comments: { some: { body: { contains: t } } } }] };
        return op === '!~' ? { NOT: w } : w;
      }
      case 'created':
        return dateClause('createdAt', op, values, pos);
      case 'updated':
        return dateClause('updatedAt', op, values, pos);
      case 'resolved':
        return dateClause('resolvedAt', op, values, pos);
      case 'due':
        return dateClause('dueDate', op, values, pos);
      case 'start':
        return dateClause('startDate', op, values, pos);
      case 'points': {
        if (op === 'is empty' || op === 'is not empty') return empty({ storyPoints: null });
        if (op === '~' || op === '!~') throw new JqlError('storyPoints é numérico', pos);
        const num = (v: Value) => {
          const n = Number(v.text);
          if (!Number.isFinite(n)) throw new JqlError(`Número inválido: "${v.text}"`, v.pos);
          return n;
        };
        if (eqLike) return membership(field, values, neg, (v) => ({ storyPoints: num(v) }));
        const n = num(values[0]);
        return { storyPoints: op === '>' ? { gt: n } : op === '>=' ? { gte: n } : op === '<' ? { lt: n } : { lte: n } };
      }
    }
    throw new JqlError(`Campo desconhecido: "${c.field}"`, pos);
  }

  async function compile(node: Node): Promise<Where> {
    if (node.kind === 'clause') return clause(node);
    if (node.kind === 'not') return { NOT: await compile(node.item) };
    const items = await Promise.all(node.items.map(compile));
    return node.kind === 'and' ? { AND: items } : { OR: items };
  }

  const where = parsed.where ? await compile(parsed.where) : {};
  const orderBy: Prisma.IssueOrderByWithRelationInput[] = [];
  let sortByPriority: 'asc' | 'desc' | undefined;
  const ORDER_COLUMNS: Record<string, keyof Prisma.IssueOrderByWithRelationInput> = {
    created: 'createdAt', updated: 'updatedAt', resolved: 'resolvedAt', due: 'dueDate', start: 'startDate',
    points: 'storyPoints', key: 'number', type: 'type', summary: 'title', status: 'status',
  };
  for (const o of parsed.orderBy) {
    const f = FIELD_ALIASES[normalize(o.field)] ?? normalize(o.field);
    if (f === 'priority') {
      sortByPriority = o.dir;
      continue;
    }
    if (f === 'rank') {
      orderBy.push({ rank: o.dir });
      continue;
    }
    const col = ORDER_COLUMNS[f];
    if (!col) throw new JqlError(`Não é possível ordenar por "${o.field}"`, o.pos);
    if (col === 'number') orderBy.push({ projectId: 'asc' }, { number: o.dir });
    else orderBy.push({ [col]: o.dir });
  }
  return { where, orderBy, sortByPriority };
}

/** Sorts in memory by priority (HIGHEST first for DESC), keeping the database order as tie-break. */
export function sortByPriority<T extends { priority: string }>(issues: T[], dir: 'asc' | 'desc') {
  const rank = (p: string) => PRIORITY_ORDER.indexOf(p);
  return [...issues].sort((a, b) => (dir === 'desc' ? rank(b.priority) - rank(a.priority) : rank(a.priority) - rank(b.priority)));
}

/** Parses and compiles in one go, for callers that only need a WHERE clause. */
export async function jqlWhere(jql: string, ctx: Ctx) {
  return compileJql(parseJql(jql), ctx);
}
