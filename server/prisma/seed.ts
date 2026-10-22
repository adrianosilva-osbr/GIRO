import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  if (await prisma.user.count()) {
    console.log('Banco já possui dados — seed ignorado. Use "npm run db:reset -w server" para recriar.');
    return;
  }

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

  const now = Date.now();
  const sprint1 = await prisma.sprint.create({
    data: {
      projectId: project.id,
      name: 'LOJA Sprint 1',
      goal: 'Catálogo navegável e carrinho funcionando',
      status: 'ACTIVE',
      startDate: new Date(now - 5 * DAY),
      endDate: new Date(now + 9 * DAY),
    },
  });
  const sprint2 = await prisma.sprint.create({
    data: { projectId: project.id, name: 'LOJA Sprint 2', goal: 'Checkout e pagamentos' },
  });

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
  }) => {
    n += 1;
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
        activities: { create: { userId: ana.id, action: 'created' } },
      },
    });
  };

  const catalogo = await create({ title: 'Catálogo de produtos', type: 'EPIC', priority: 'HIGH' });
  const carrinho = await create({ title: 'Carrinho de compras', type: 'EPIC' });
  const checkout = await create({ title: 'Checkout e pagamento', type: 'EPIC', priority: 'HIGHEST' });

  await create({
    title: 'Listar produtos com paginação',
    type: 'STORY',
    status: 'DONE',
    storyPoints: 5,
    assigneeId: bruno.id,
    sprintId: sprint1.id,
    parentId: catalogo.id,
    labels: ['frontend'],
    description: 'Como cliente, quero ver os produtos em páginas de 20 itens para navegar com facilidade.',
  });
  const busca = await create({
    title: 'Busca de produtos por nome',
    type: 'STORY',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    storyPoints: 8,
    assigneeId: carla.id,
    sprintId: sprint1.id,
    parentId: catalogo.id,
    labels: ['frontend', 'backend'],
  });
  await create({ title: 'Criar índice de busca no banco', type: 'SUBTASK', status: 'DONE', assigneeId: carla.id, sprintId: sprint1.id, parentId: busca.id });
  await create({ title: 'Campo de busca no cabeçalho', type: 'SUBTASK', assigneeId: carla.id, sprintId: sprint1.id, parentId: busca.id });
  await create({
    title: 'Imagem do produto quebra no Safari',
    type: 'BUG',
    status: 'IN_REVIEW',
    priority: 'HIGHEST',
    storyPoints: 2,
    assigneeId: bruno.id,
    sprintId: sprint1.id,
    labels: ['frontend'],
  });
  await create({ title: 'Adicionar item ao carrinho', type: 'STORY', storyPoints: 5, assigneeId: ana.id, sprintId: sprint1.id, parentId: carrinho.id });
  await create({ title: 'Configurar pipeline de CI', type: 'TASK', status: 'TODO', priority: 'LOW', storyPoints: 3, sprintId: sprint1.id, labels: ['devops'] });

  await create({ title: 'Integração com gateway de pagamento', type: 'STORY', priority: 'HIGHEST', storyPoints: 13, sprintId: sprint2.id, parentId: checkout.id, labels: ['backend'] });
  await create({ title: 'Cálculo de frete por CEP', type: 'STORY', storyPoints: 8, sprintId: sprint2.id, parentId: checkout.id });

  await create({ title: 'Cupom de desconto', type: 'STORY', priority: 'LOW', storyPoints: 5, parentId: carrinho.id });
  await create({ title: 'Filtro por faixa de preço', type: 'STORY', storyPoints: 3, parentId: catalogo.id });
  await create({ title: 'Atualizar dependências do projeto', type: 'TASK', priority: 'LOWEST', labels: ['devops'] });
  await create({ title: 'Total do carrinho não atualiza ao remover item', type: 'BUG', priority: 'HIGH', parentId: carrinho.id });

  await prisma.project.update({ where: { id: project.id }, data: { issueCounter: n, sprintCounter: 2 } });

  console.log('Seed concluído. Usuários: ana@giro.dev, bruno@giro.dev, carla@giro.dev — senha: giro123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
