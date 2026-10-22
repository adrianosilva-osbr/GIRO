import 'dotenv/config';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_STATUSES } from '../src/workflow.js';

const prisma = new PrismaClient();
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
/** A moment `d` days from now (negative = past), at 10:00 local-ish so days don't straddle midnight. */
const day = (d: number) => {
  const t = new Date(now + d * DAY);
  t.setHours(10, 0, 0, 0);
  return t;
};

async function main() {
  if (await prisma.user.count()) {
    console.log('Banco já possui dados — seed ignorado. Use "npm run db:reset -w server" para recriar.');
    return;
  }

  // A fresh database has no attachment rows, so any files left in uploads/ are orphans.
  const uploads = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads'));
  fs.rmSync(uploads, { recursive: true, force: true });

  const passwordHash = await bcrypt.hash('giro123', 10);
  const [ana, bruno, carla] = await Promise.all([
    prisma.user.create({ data: { name: 'Ana Souza', email: 'ana@giro.dev', passwordHash, avatarColor: '#0C66E4' } }),
    prisma.user.create({ data: { name: 'Bruno Lima', email: 'bruno@giro.dev', passwordHash, avatarColor: '#1F845A' } }),
    prisma.user.create({ data: { name: 'Carla Mendes', email: 'carla@giro.dev', passwordHash, avatarColor: '#6E5DC6' } }),
  ]);

  const project = await prisma.project.create({
    data: {
      key: 'LOJA',
      name: 'Loja Online',
      description: 'Novo e-commerce da empresa — catálogo, carrinho e checkout.',
      leadId: ana.id,
      members: {
        create: [
          { userId: ana.id, role: 'ADMIN' },
          { userId: bruno.id, role: 'MEMBER' },
          { userId: carla.id, role: 'MEMBER' },
        ],
      },
    },
  });

  // Default workflow, with a WIP limit on the "in progress" column.
  await prisma.projectStatus.createMany({
    data: DEFAULT_STATUSES.map((s, position) => ({ ...s, projectId: project.id, position, wipLimit: s.key === 'IN_PROGRESS' ? 3 : null })),
  });
  const ambiente = await prisma.customField.create({
    data: { projectId: project.id, name: 'Ambiente', type: 'SELECT', options: JSON.stringify(['Produção', 'Homologação', 'Desenvolvimento']), position: 0 },
  });
  const cliente = await prisma.customField.create({ data: { projectId: project.id, name: 'Cliente solicitante', type: 'TEXT', position: 1 } });

  // Three finished two-week sprints, the current one, and the next one.
  const sprint = (n: number, goal: string, status: string, start?: number) =>
    prisma.sprint.create({
      data: {
        projectId: project.id,
        name: `LOJA Sprint ${n}`,
        goal,
        status,
        startDate: start !== undefined ? day(start) : null,
        endDate: start !== undefined ? day(start + 14) : null,
        completedAt: status === 'CLOSED' ? day(start! + 14) : null,
      },
    });
  const s1 = await sprint(1, 'Base técnica do projeto', 'CLOSED', -47);
  const s2 = await sprint(2, 'Primeira versão do catálogo', 'CLOSED', -33);
  const s3 = await sprint(3, 'Catálogo completo', 'CLOSED', -19);
  const s4 = await sprint(4, 'Busca e carrinho funcionando', 'ACTIVE', -5);
  const s5 = await sprint(5, 'Checkout e pagamentos', 'PLANNED');

  let n = 0;
  const create = async (data: {
    title: string;
    type: string;
    status?: string;
    priority?: string;
    storyPoints?: number;
    assigneeId?: string;
    sprintId?: string;
    parentId?: string;
    labels?: string[];
    description?: string;
    created: number;
    resolved?: number;
    startDate?: number;
    dueDate?: number;
  }) => {
    n += 1;
    const createdAt = day(data.created);
    return prisma.issue.create({
      data: {
        projectId: project.id,
        number: n,
        key: `LOJA-${n}`,
        rank: n,
        reporterId: ana.id,
        title: data.title,
        type: data.type,
        status: data.status ?? 'TODO',
        priority: data.priority ?? 'MEDIUM',
        storyPoints: data.storyPoints,
        assigneeId: data.assigneeId,
        sprintId: data.sprintId,
        parentId: data.parentId,
        description: data.description ?? '',
        labels: data.labels?.length ? `,${data.labels.join(',')},` : '',
        createdAt,
        updatedAt: data.resolved !== undefined ? day(data.resolved) : createdAt,
        resolvedAt: data.resolved !== undefined ? day(data.resolved) : null,
        startDate: data.startDate !== undefined ? day(data.startDate) : null,
        dueDate: data.dueDate !== undefined ? day(data.dueDate) : null,
        activities: { create: { userId: ana.id, action: 'created', createdAt } },
        watchers: { create: [...new Set([ana.id, data.assigneeId].filter((id): id is string => !!id))].map((userId) => ({ userId })) },
      },
    });
  };

  // Sprint history, replayed by the burndown/velocity reports.
  type Issue = { id: string; key: string };
  const events: { sprintId: string; issueId: string; issueKey: string; type: string; points?: number; done?: boolean; at: Date }[] = [];
  const ev = (sprintId: string, issue: Issue, type: string, at: number, points?: number) =>
    events.push({ sprintId, issueId: issue.id, issueKey: issue.key, type, points, at: day(at) });

  // ---- Epics
  const fundacao = await create({ title: 'Fundação técnica', type: 'EPIC', status: 'DONE', created: -50, resolved: -33, startDate: -48, dueDate: -33 });
  const catalogo = await create({ title: 'Catálogo de produtos', type: 'EPIC', priority: 'HIGH', created: -50, startDate: -34, dueDate: 9 });
  const carrinho = await create({ title: 'Carrinho de compras', type: 'EPIC', created: -40, startDate: -6, dueDate: 24 });
  const checkout = await create({ title: 'Checkout e pagamento', type: 'EPIC', priority: 'HIGHEST', created: -40, startDate: 9, dueDate: 45 });
  const areaCliente = await create({ title: 'Área do cliente', type: 'EPIC', priority: 'LOW', created: -12 });

  // ---- Sprint 1: committed 21, delivered 13 (authentication spilled over)
  const repo = await create({ title: 'Configurar projeto e repositório', type: 'TASK', status: 'DONE', storyPoints: 3, assigneeId: bruno.id, sprintId: s1.id, parentId: fundacao.id, labels: ['devops'], created: -49, resolved: -45 });
  const modelo = await create({ title: 'Modelo de dados de produtos', type: 'STORY', status: 'DONE', storyPoints: 5, assigneeId: carla.id, sprintId: s1.id, parentId: fundacao.id, labels: ['backend'], created: -49, resolved: -40 });
  const layout = await create({ title: 'Layout base do site', type: 'STORY', status: 'DONE', storyPoints: 5, assigneeId: ana.id, sprintId: s1.id, parentId: fundacao.id, labels: ['frontend'], created: -49, resolved: -36 });
  const login = await create({ title: 'Autenticação de clientes', type: 'STORY', status: 'DONE', storyPoints: 8, assigneeId: bruno.id, sprintId: s2.id, parentId: fundacao.id, labels: ['backend'], created: -49, resolved: -28 });
  for (const [i, p] of [[repo, 3], [modelo, 5], [layout, 5], [login, 8]] as const) ev(s1.id, i, 'committed', -47, p);
  ev(s1.id, repo, 'done', -45);
  ev(s1.id, modelo, 'done', -40);
  ev(s1.id, layout, 'done', -36);

  // ---- Sprint 2: committed 21, a bug added mid-sprint, delivered 18
  const pagina = await create({ title: 'Página de produto', type: 'STORY', status: 'DONE', storyPoints: 5, assigneeId: carla.id, sprintId: s2.id, parentId: catalogo.id, labels: ['frontend'], created: -35, resolved: -24 });
  const imagens = await create({ title: 'Upload de imagens de produto', type: 'STORY', status: 'DONE', storyPoints: 5, assigneeId: bruno.id, sprintId: s3.id, parentId: catalogo.id, labels: ['backend'], created: -35, resolved: -14 });
  const categorias = await create({ title: 'Cadastro de categorias', type: 'STORY', status: 'DONE', storyPoints: 3, assigneeId: ana.id, sprintId: s2.id, parentId: catalogo.id, created: -35, resolved: -27 });
  const slug = await create({ title: 'Slug de produto duplicado gera erro 500', type: 'BUG', status: 'DONE', priority: 'HIGH', storyPoints: 2, assigneeId: carla.id, sprintId: s2.id, parentId: catalogo.id, created: -26, resolved: -23 });
  for (const [i, p] of [[login, 8], [pagina, 5], [imagens, 5], [categorias, 3]] as const) ev(s2.id, i, 'committed', -33, p);
  ev(s2.id, categorias, 'done', -27);
  ev(s2.id, login, 'done', -28);
  ev(s2.id, slug, 'added', -26, 2);
  ev(s2.id, pagina, 'done', -24);
  ev(s2.id, slug, 'done', -23);

  // ---- Sprint 3: committed 23, delivered 15 (cache went back to the backlog)
  const ordenacao = await create({ title: 'Ordenação de produtos', type: 'STORY', status: 'DONE', storyPoints: 3, assigneeId: carla.id, sprintId: s3.id, parentId: catalogo.id, created: -21, resolved: -16 });
  const breadcrumbs = await create({ title: 'Breadcrumbs de navegação', type: 'TASK', status: 'DONE', storyPoints: 2, assigneeId: ana.id, sprintId: s3.id, parentId: catalogo.id, labels: ['frontend'], created: -21, resolved: -12 });
  const seo = await create({ title: 'SEO das páginas de produto', type: 'STORY', status: 'DONE', storyPoints: 5, assigneeId: bruno.id, sprintId: s3.id, parentId: catalogo.id, created: -21, resolved: -7 });
  const cache = await create({ title: 'Cache do catálogo', type: 'TASK', storyPoints: 8, parentId: catalogo.id, labels: ['backend'], created: -21 });
  for (const [i, p] of [[imagens, 5], [ordenacao, 3], [breadcrumbs, 2], [seo, 5], [cache, 8]] as const) ev(s3.id, i, 'committed', -19, p);
  ev(s3.id, ordenacao, 'done', -16);
  ev(s3.id, imagens, 'done', -14);
  ev(s3.id, breadcrumbs, 'done', -12);
  ev(s3.id, seo, 'done', -7);

  // ---- Sprint 4 (active): committed 17, re-estimate +3, CI added +3, one story done
  const listar = await create({
    title: 'Listar produtos com paginação',
    type: 'STORY',
    status: 'DONE',
    storyPoints: 5,
    assigneeId: bruno.id,
    sprintId: s4.id,
    parentId: catalogo.id,
    labels: ['frontend'],
    description: 'Como cliente, quero ver os produtos em páginas de 20 itens para navegar com facilidade.',
    created: -8,
    resolved: -2,
  });
  const busca = await create({ title: 'Busca de produtos por nome', type: 'STORY', status: 'IN_PROGRESS', priority: 'HIGH', storyPoints: 8, assigneeId: carla.id, sprintId: s4.id, parentId: catalogo.id, labels: ['frontend', 'backend'], created: -8 });
  await create({ title: 'Criar índice de busca no banco', type: 'SUBTASK', status: 'DONE', assigneeId: carla.id, sprintId: s4.id, parentId: busca.id, created: -4, resolved: -1 });
  await create({ title: 'Campo de busca no cabeçalho', type: 'SUBTASK', assigneeId: carla.id, sprintId: s4.id, parentId: busca.id, created: -4 });
  const safari = await create({ title: 'Imagem do produto quebra no Safari', type: 'BUG', status: 'IN_REVIEW', priority: 'HIGHEST', storyPoints: 2, assigneeId: bruno.id, sprintId: s4.id, labels: ['frontend'], created: -6, dueDate: -1 });
  const adicionar = await create({ title: 'Adicionar item ao carrinho', type: 'STORY', storyPoints: 5, assigneeId: ana.id, sprintId: s4.id, parentId: carrinho.id, created: -8, dueDate: 3 });
  const ci = await create({ title: 'Configurar pipeline de CI', type: 'TASK', priority: 'LOW', storyPoints: 3, sprintId: s4.id, labels: ['devops'], created: -3 });
  ev(s4.id, listar, 'committed', -5, 5);
  ev(s4.id, busca, 'committed', -5, 5);
  ev(s4.id, safari, 'committed', -5, 2);
  ev(s4.id, adicionar, 'committed', -5, 5);
  ev(s4.id, busca, 'points', -4, 8);
  ev(s4.id, ci, 'added', -3, 3);
  ev(s4.id, listar, 'done', -2);

  // ---- Next sprint and backlog
  await create({ title: 'Integração com gateway de pagamento', type: 'STORY', priority: 'HIGHEST', storyPoints: 13, sprintId: s5.id, parentId: checkout.id, labels: ['backend'], created: -10 });
  await create({ title: 'Cálculo de frete por CEP', type: 'STORY', storyPoints: 8, sprintId: s5.id, parentId: checkout.id, created: -10 });
  await create({ title: 'Cupom de desconto', type: 'STORY', priority: 'LOW', storyPoints: 5, parentId: carrinho.id, created: -9 });
  await create({ title: 'Filtro por faixa de preço', type: 'STORY', storyPoints: 3, parentId: catalogo.id, created: -9 });
  await create({ title: 'Atualizar dependências do projeto', type: 'TASK', priority: 'LOWEST', labels: ['devops'], created: -4 });
  await create({ title: 'Total do carrinho não atualiza ao remover item', type: 'BUG', priority: 'HIGH', parentId: carrinho.id, created: -1 });
  await create({ title: 'Lista de desejos', type: 'STORY', storyPoints: 5, parentId: areaCliente.id, created: -2 });

  await prisma.sprintEvent.createMany({ data: events });

  // The CI pipeline must exist before the cart story can ship.
  await prisma.issueLink.create({ data: { type: 'BLOCKS', sourceId: ci.id, targetId: adicionar.id, createdById: ana.id } });

  // Time tracking: one issue on track, one over its estimate.
  await prisma.issue.update({ where: { id: busca.id }, data: { originalEstimate: 3 * 480, timeSpent: 900, remainingEstimate: 600 } });
  await prisma.issue.update({ where: { id: safari.id }, data: { originalEstimate: 240, timeSpent: 300, remainingEstimate: 60 } });
  await prisma.workLog.createMany({
    data: [
      { issueId: busca.id, userId: carla.id, minutes: 480, startedAt: day(-3), description: 'Índice de busca e API' },
      { issueId: busca.id, userId: carla.id, minutes: 420, startedAt: day(-1), description: 'Campo de busca no cabeçalho' },
      { issueId: safari.id, userId: bruno.id, minutes: 300, startedAt: day(-2), description: 'Investigação e correção do decode de imagem' },
    ],
  });

  await prisma.customFieldValue.createMany({
    data: [
      { issueId: safari.id, fieldId: ambiente.id, value: 'Produção' },
      { issueId: safari.id, fieldId: cliente.id, value: 'Loja Centro' },
      { issueId: busca.id, fieldId: cliente.id, value: 'Marketing' },
    ],
  });

  await prisma.automationRule.createMany({
    data: [
      {
        projectId: project.id,
        name: 'Concluir a issue pai quando todas as subtarefas terminarem',
        trigger: 'subtasks_done',
        actions: JSON.stringify([
          { type: 'set_status', value: 'DONE' },
          { type: 'add_comment', value: 'Todas as subtarefas de {{key}} foram concluídas. Issue concluída automaticamente.' },
        ]),
        createdById: ana.id,
      },
      {
        projectId: project.id,
        name: 'Bugs de prioridade muito alta vão para a Ana',
        trigger: 'issue_created',
        condition: 'type = Bug AND priority = "Muito alta" AND assignee IS EMPTY',
        actions: JSON.stringify([{ type: 'assign', value: ana.id }, { type: 'add_label', value: 'urgente' }]),
        createdById: ana.id,
      },
    ],
  });

  await prisma.savedFilter.createMany({
    data: [
      { ownerId: ana.id, name: 'Bugs em aberto', jql: 'type = Bug AND statusCategory != Done ORDER BY priority DESC', shared: true },
      { ownerId: ana.id, name: 'Vencidas ou vencendo', jql: 'due <= 7d AND statusCategory != Done ORDER BY due', shared: true },
      { ownerId: bruno.id, name: 'Frontend da sprint', jql: 'labels = frontend AND sprint IN openSprints()', shared: false },
    ],
  });
  await prisma.project.update({ where: { id: project.id }, data: { issueCounter: n, sprintCounter: 5 } });

  console.log('Seed concluído. Usuários: ana@giro.dev, bruno@giro.dev, carla@giro.dev — senha: giro123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
