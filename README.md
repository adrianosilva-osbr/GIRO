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
- **Texto formatado**: descrição e comentários em Markdown, com barra de ferramentas, pré-visualização e menções com `@`.
- **Anexos**: arquivos de até 10 MB por issue, com visualização de imagens. Prints colados ou arrastados para a descrição ou um comentário são anexados automaticamente.
- **Vínculos entre issues**: bloqueia / é bloqueada por, relaciona-se com, duplica / é duplicada por.
- **Notificações**: sino no topo da tela e e-mail (desativável no perfil) quando alguém atribui uma issue a você, menciona você, ou comenta e muda o status de issues que você observa.
- **Tempo real**: quadro, backlog, issues e notificações se atualizam sozinhos quando outra pessoa faz alterações.
- **Contas**: recuperação de senha por e-mail e troca de senha no perfil. Trocar a senha encerra as outras sessões.
- **Resumo do projeto**: issues concluídas, criadas e vencidas, gráfico de criadas x concluídas (30 dias), distribuição por status, tipo, prioridade e responsável, progresso dos épicos e atividade recente.
- **Relatórios**: burndown da sprint (ativa ou encerrada) com mudanças de escopo e relatório das issues concluídas, não concluídas e removidas; velocidade (comprometido x concluído por sprint, com média). Ambos em story points ou quantidade de issues.
- **Cronograma**: épicos numa linha do tempo, com barras que se arrastam para mover ou redimensionar as datas de início e fim.
- **Fluxo de trabalho por projeto**: status próprios (criar, renomear, reordenar, excluir), cada um numa categoria — A fazer, Em andamento ou Concluído — que define o que conta como entregue.
- **Quadro configurável**: limite de WIP por coluna (sinalizado em vermelho quando excedido) e raias por responsável ou épico.
- **Campos personalizados**: texto, número, data ou lista de opções, editáveis no detalhe da issue.
- **Busca JQL e filtros salvos**: consultas como `type = Bug AND statusCategory != Done ORDER BY priority DESC`, com campos personalizados, funções (`currentUser()`, `openSprints()`, `-7d`) e filtros pessoais ou compartilhados.
- **Automações**: regras “quando → se (JQL) → então” por projeto, com modelos prontos e histórico de execuções.
- **Ações em massa**: na busca, selecione várias issues e mude status, responsável, prioridade, sprint ou etiquetas, ou exclua de uma vez.
- **Exportação**: o resultado de qualquer busca (básica ou JQL) sai em Excel (.xlsx) ou CSV, com campos personalizados e controle de tempo.
- **Controle de tempo**: estimativa original, tempo restante e registros de trabalho no formato do Jira (`2h 30m`, `1d` = 8h); também pesquisável no JQL (`timeSpent > 4h`).
- **Clonar e mover**: clone uma issue com subtarefas e campos, ou mova-a para outro projeto (a chave antiga continua funcionando).
- **Issues bloqueadas**: cartões e listas sinalizam issues bloqueadas por outras ainda não concluídas (JQL: `blocked = true`).
- **Atalhos de teclado**: `c` cria, `/` busca, `g` + letra navega (`g b` quadro, `g l` backlog…), `j`/`k`/`x`/`o` na lista de issues, `a`/`m`/`l`/`w` dentro da issue e `?` mostra todos.

## Stack

| Parte | Tecnologias |
| --- | --- |
| `server/` | Node + Express, Prisma ORM, SQLite, zod, JWT, multer (uploads), nodemailer (e-mail), Server-Sent Events |
| `client/` | React + TypeScript, Vite, React Router, TanStack Query, dnd-kit, marked + DOMPurify |

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

## Configuração

Variáveis em `server/.env` (veja [server/.env.example](server/.env.example)):

- `JWT_SECRET`: segredo das sessões e dos links de anexos. Use um valor longo e aleatório.
- `APP_URL`: endereço do frontend, usado nos links dos e-mails.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: envio de e-mails. Sem `SMTP_HOST`, os e-mails (inclusive os links de redefinição de senha) aparecem no console do servidor.
- `UPLOAD_DIR`: pasta dos anexos (padrão `server/uploads`). Inclua essa pasta no backup junto com o banco.

As atualizações em tempo real ficam na memória do processo, então a API deve rodar como uma única instância.

Para usar Postgres em produção, troque o `provider` em [server/prisma/schema.prisma](server/prisma/schema.prisma) e a `DATABASE_URL`.
