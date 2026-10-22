# GIRO

Ferramenta web de gestão de projetos e issues no estilo Jira.

## Funcionalidades

- **Contas e acesso**: cadastro e login (JWT), membros por projeto com papéis de Administrador e Membro.
- **Projetos**: chave própria (ex: `LOJA`), e issues numeradas automaticamente (`LOJA-1`, `LOJA-2`…).
- **Issues**: tipos Épico, História, Tarefa, Bug e Subtarefa, com hierarquia épico → issue → subtarefa. Cada issue tem status, prioridade, responsável, story points, etiquetas, data limite, comentários e histórico de alterações.
- **Quadro Kanban**: colunas por status, arrastar e soltar entre colunas e reordenar, filtros rápidos por pessoa, épico e texto.
- **Backlog e sprints**: arrastar issues entre backlog e sprints, criar, iniciar, editar, encerrar e excluir sprints. Ao encerrar, as issues não concluídas vão para o backlog ou para outra sprint.
- **Busca e filtros**: filtros por projeto, tipo, status, prioridade, responsável, sprint e etiqueta. Os filtros ficam na URL, então dá para compartilhar o link.
- **Links diretos para issues**: qualquer página com `?issue=LOJA-5` abre a issue.

## Stack

| Parte | Tecnologias |
| --- | --- |
| `server/` | Node + Express, Prisma ORM, SQLite, zod, JWT |
| `client/` | React + TypeScript, Vite, React Router, TanStack Query, dnd-kit |

## Como rodar

Requer Node 20+.

```bash
cp server/.env.example server/.env   # ajuste JWT_SECRET
npm run setup                        # instala dependências, cria o banco e popula dados de exemplo
npm run dev                          # API em :4000 e web em http://localhost:5173
```

Usuários de exemplo (senha `giro123`): `ana@giro.dev` (admin), `bruno@giro.dev`, `carla@giro.dev`.

## Outros comandos

```bash
npm test                      # testes de integração da API
npm run typecheck             # checagem de tipos do server e do client
npm run db:reset -w server    # recria o banco do zero com os dados de exemplo
npm run build && npm start    # build de produção; a API também serve o frontend em :4000
```

Para usar Postgres em produção, troque o `provider` em [server/prisma/schema.prisma](server/prisma/schema.prisma) e a `DATABASE_URL`.
