# Forma — Gestão do Personal

## Visão geral

Forma é uma plataforma web para apoiar a gestão diária de um personal trainer: organização de alunos, consulta de treinos, registro de pagamentos e acompanhamento financeiro. A aplicação é multi-tenant: cada personal acessa somente os dados associados à própria conta.

Esta especificação descreve o modelo de dados existente e o comportamento implementado no código. Entidades presentes no banco, mas sem fluxo completo na interface/API, são identificadas como tal para distinguir a arquitetura prevista das funcionalidades já disponíveis.

## Tecnologias e estrutura

- **Interface:** HTML, CSS e JavaScript, construída com Vite.
- **API:** Node.js, TypeScript e Express.
- **Banco de dados:** PostgreSQL, acessado por Prisma ORM.
- **Autenticação:** Supabase Auth; a API valida o token e confere o vínculo do usuário com um cadastro de personal.
- **Validação de entrada:** Zod.
- **Testes:** Vitest e Supertest.

Diretórios e arquivos importantes:

- `src/ui/`: interface e estilos.
- `src/api/`: autenticação e rotas HTTP.
- `src/db/`: acesso Prisma com escopo de tenant e integração Supabase.
- `src/dashboard/`, `src/bi/`: serviços e regras de métricas.
- `prisma/schema.prisma`: modelo de dados Prisma.
- `prisma/migrations/`: migrations geradas e scripts SQL manuais.
- `tests/`: testes unitários e de integração.

## Interface e identidade visual

O documento HTML define o idioma `pt-BR`, o título **Forma — Gestão do Personal** e a descrição da aplicação. A interface é apresentada em português do Brasil.

### Navegação e telas disponíveis

- **Visão geral:** resumo de alunos, treinos e finanças; gráfico de receita recebida em seis meses; contratos próximos do vencimento e alertas.
- **Alunos:** listagem paginada, filtro por status, busca, cadastro básico e abertura dos detalhes de cada aluno.
- **Detalhes do aluno:** dados cadastrais, total recebido, histórico de pagamentos e ação para registrar novo pagamento.
- **Treinos:** criação de planos semanais por aluno, com grupos de exercícios nos dias escolhidos; consulta do treino ativo e do histórico; ativação e desativação manual.
- **Financeiro:** totais do mês, valores a receber, receita recorrente, gráfico de seis meses e movimentações recentes.

### Comportamentos da interface

- Navegação lateral com estado ativo, cabeçalho com busca e adaptação a telas menores.
- Formulários em modal para cadastro de aluno e registro de pagamento.
- Mensagens de carregamento, erro, validação e confirmação de operação.
- Valores exibidos em reais (BRL) e datas formatadas para `pt-BR`.
- A sessão do Supabase Auth é persistida em `sessionStorage`.

### Cores e tipografia

Paleta extraída dos estilos da aplicação:

| Uso | Cor |
| --- | --- |
| Fundo geral | `#f5f7fb` |
| Azul-marinho da navegação | `#20283e` |
| Texto principal | `#242a3b` |
| Azul principal (destaques e ícones) | `#5b70e8` |
| Azul dos botões principais | `#5d70e4` |
| Verde de sucesso e recebimentos | `#2daf82` |
| Superfície dos cartões e modais | `#ffffff` |
| Bordas e divisórias | `#edf0f5` |
| Texto secundário | `#8c93a4` |
| Âmbar para alertas | `#d29638` |

As fontes são **DM Sans** (texto geral) e **Manrope** (títulos e valores destacados), com fontes locais do sistema como alternativa.

## Regras de negócio

### Contas, papéis e tenant

- Os papéis definidos são `ADMIN`, `PERSONAL` e `STUDENT`; a API de gestão atual aceita usuários autenticados com papel `PERSONAL`.
- O tenant é o `personalId` associado à identidade autenticada no banco. Ele não é aceito como fonte de autorização a partir de parâmetros enviados pelo navegador.
- Consultas e gravações de modelos de tenant usam `getScopedPrisma(personalId)`, que injeta o escopo do personal. Modelos sem regra explícita são bloqueados por padrão.
- Um personal não pode consultar nem vincular dados pertencentes a outro personal.

### Alunos

- Aluno pertence a um personal, tem nome, e-mail e status ativo/inativo.
- E-mail é validado no cadastro.
- Registros anonimizados (`anonymizedAt` preenchido) não aparecem na listagem nem na consulta de detalhes.
- O schema prevê retenção do histórico financeiro após anonimização; relações financeiras não usam exclusão em cascata.
- A listagem apresenta o contrato mais recente, quando existir, e usa paginação de 50 itens.

### Pagamentos de alunos

- O personal registra valor pago, forma de pagamento e data.
- Formas aceitas: Pix, dinheiro, cartão de crédito, cartão de débito, transferência bancária e outro.
- Valor deve ser positivo, ter no máximo duas casas decimais e respeitar o limite validado pela API.
- A data é informada como dia civil (`AAAA-MM-DD`) e validada antes da gravação.
- O lançamento é armazenado como `ExtraPayment`, vinculado ao personal e ao aluno, com status `CONFIRMED`, `confirmedAt` e a forma de pagamento.
- Pagamento confirmado é receita recebida e aparece no histórico do aluno e nas movimentações financeiras.
- A forma de pagamento histórica é preservada. Pagamentos existentes recebem `OTHER` como padrão na migration que introduz o campo.
- A tela de detalhes soma pagamentos confirmados para mostrar o total recebido pelo aluno.

### Financeiro e dashboard

- **Recebido neste mês:** soma, em centavos, dos pagamentos confirmados de parcelas e receitas avulsas com confirmação no mês atual.
- **Gráfico de receita recebida:** soma de pagamentos confirmados dos últimos seis meses, agrupada pelo mês de `confirmedAt`. O filtro inclui o dia atual inteiro para contemplar pagamentos registrados para hoje com horário posterior ao instante da consulta.
- **A receber:** soma valores de parcelas e receitas avulsas em status `PENDING` ou `FAILED`.
- **Atrasos:** contagem de itens pendentes ou falhos cuja data de vencimento já passou.
- **Receita recorrente:** soma mensal (`monthlyAmount`) de contratos `SIGNED` cuja vigência inclui a data atual. Não é o total de pagamentos recebidos; pode ser zero mesmo quando há receitas avulsas confirmadas.
- **Movimentações:** até dez lançamentos recentes, ordenados pela data de confirmação ou vencimento; receitas avulsas apresentam também a forma de pagamento quando disponível.
- Valores monetários são convertidos para centavos durante as somas para reduzir erros de arredondamento.

### Treinos e revisão

- Um treino é um plano semanal com nome, aluno associado e conjuntos de exercícios organizados pelos dias escolhidos da semana. Cada dia escolhido deve ter pelo menos um exercício; cada exercício registra nome, número de séries, repetições por série e descanso em segundos.
- Um dia da semana pode aparecer no máximo uma vez em cada plano; cada plano pode abranger de um a sete dias e conter até 50 exercícios no total.
- Todo plano criado começa ativo. Cada aluno pode ter no máximo um plano ativo: criar um novo desativa automaticamente o plano ativo anterior do mesmo aluno.
- O personal pode desativar um treino e reativar um treino do histórico; ao reativar, o plano atualmente ativo do aluno é desativado.
- Planos inativos são mantidos no histórico. Alunos inativos ou anonimizados não podem ser selecionados na criação.
- Séries e repetições devem ser inteiros positivos; descanso é inteiro em segundos e pode ser zero. Cada dia escolhido exige pelo menos um exercício.
- Exercícios anteriores à agenda semanal permanecem no histórico com o dia não definido; planos antigos sem exercícios associados são identificados como treinos legados.
- O dashboard sinaliza treinos ativos sem atualização há mais de 30 dias.
- A criação substitui apenas o plano ativo do mesmo aluno; treinos de outros alunos e tenants não são afetados.

### Contratos, parcelas, leads e exames

- Contrato tem ciclo de 3, 6 ou 12 meses, valores total e mensal, datas de vigência e status de assinatura/cancelamento/expiração.
- Parcela pertence a um contrato, possui vencimento, valor, status e data de confirmação opcional.
- Leads têm status comercial e podem ser associados a um aluno convertido.
- Exames têm chave de arquivo, status de revisão e campo opcional para dados extraídos criptografados.
- Esses modelos e algumas regras de BI/dashboard existem no schema e nos serviços, mas não têm um fluxo completo de gerenciamento nas telas descritas neste documento.

## Banco de dados e entidades

O banco é PostgreSQL, com identificadores UUID armazenados como `TEXT`, datas `TIMESTAMP(3)` e valores monetários `DECIMAL(65,30)`. As tabelas usam nomes em snake_case via `@@map`; os campos Prisma seguem camelCase.

| Entidade Prisma | Tabela | Responsabilidade e relações principais |
| --- | --- | --- |
| `User` | `users` | Identidade, papel, provedor e vínculo opcional com `Personal` ou `Student`. |
| `Personal` | `personals` | Conta do profissional e raiz dos dados de seu tenant. |
| `Student` | `students` | Cadastro do aluno, estado ativo e campos de anonimização/CPF protegido. |
| `Contract` | `contracts` | Contrato entre personal e aluno; possui parcelas. |
| `PaymentParcel` | `payment_parcels` | Parcela contratual com valor, vencimento, status e confirmação. |
| `ExtraPayment` | `extra_payments` | Receita avulsa, opcionalmente ligada a um aluno; usada no registro de pagamento individual. |
| `Workout` | `workouts` | Plano de treino de um aluno, ativo ou mantido no histórico. |
| `WorkoutExercise` | `workout_exercises` | Exercício e parâmetros (dia da semana, séries, repetições, descanso e ordem) de um plano. |
| `Lead` | `leads` | Potencial aluno e estado de conversão. |
| `Exam` | `exams` | Arquivo e estado de revisão de exame do aluno. |
| `ConsentGrant` | `consent_grants` | Consentimentos versionados por finalidade. |
| `AccessLog` | `access_logs` | Auditoria de acesso e escrita. |

### Enumerações

- `Role`: `ADMIN`, `PERSONAL`, `STUDENT`.
- `AuthProvider`: `GOV_BR`, `OAUTH`.
- `ContractStatus`: `DRAFT`, `PENDING_SIGNATURE`, `SIGNED`, `CANCELLED`, `EXPIRED`.
- `CycleDuration`: `MONTHS_3`, `MONTHS_6`, `MONTHS_12`.
- `ParcelStatus`: `PENDING`, `CONFIRMED`, `CANCELLED`, `FAILED`.
- `PaymentMethod`: `PIX`, `CASH`, `CREDIT_CARD`, `DEBIT_CARD`, `BANK_TRANSFER`, `OTHER`.
- `LeadStatus`: `NEW`, `CONTACTED`, `QUALIFIED`, `CONVERTED`, `DISQUALIFIED`.
- `ExamStatus`: `PENDING_REVIEW`, `CONFIRMED`, `REJECTED`.

### Integridade e privacidade

- Relações financeiras usam `ON DELETE RESTRICT`; histórico financeiro não deve ser apagado por exclusão em cascata.
- Chaves únicas compostas `(id, personalId)` e FKs compostas em SQL manual impedem relações entre tenants para alunos, contratos, parcelas, treinos, exames e leads convertidos.
- `cpfEncrypted` e `extractedDataEncrypted` são destinados a payloads cifrados na aplicação; `cpfHash` permite deduplicação sem armazenar o CPF em claro.
- `AccessLog` é append-only: trigger SQL rejeita `UPDATE` e `DELETE`.
- A consistência de conversão de lead exige que o status `CONVERTED` corresponda a `convertedStudentId` preenchido.

## API atual

As rotas abaixo são montadas sob `/api` e, exceto `/api/config`, exigem autenticação de personal.

| Método | Rota | Uso |
| --- | --- | --- |
| `GET` | `/api/config` | Fornece URL e chave publicável do Supabase para inicializar o cliente web. |
| `GET` | `/api/me` | Retorna nome e e-mail do personal autenticado. |
| `GET` | `/api/dashboard` | Retorna métricas operacionais, contratos próximos e finanças. |
| `GET` | `/api/students` | Lista alunos com paginação e filtro de status. |
| `GET` | `/api/students/options` | Busca alunos ativos para associar a um treino. |
| `POST` | `/api/students` | Cadastra aluno com nome e e-mail. |
| `GET` | `/api/students/:studentId` | Retorna dados do aluno e histórico de pagamentos. |
| `POST` | `/api/students/:studentId/payments` | Registra pagamento confirmado para aluno do tenant. |
| `GET` | `/api/workouts` | Lista treinos ativos e históricos com exercícios e contagens de revisão. |
| `POST` | `/api/workouts` | Cria plano ativo com exercícios; desativa o plano anterior do aluno na mesma transação. |
| `PATCH` | `/api/workouts/:workoutId` | Ativa ou desativa um treino, mantendo somente um ativo por aluno. |
| `GET` | `/api/finance` | Retorna totais, gráfico e movimentações financeiras. |

Respostas da API autenticada usam `Cache-Control: no-store`. Erros inesperados são registrados no servidor e retornam mensagem genérica ao cliente.

## Migrations

O schema Prisma é a referência declarativa; migrations manuais complementam as restrições que o Prisma não modela.

- `20261102103000_init_fase7`: criação inicial das entidades e enums consolidados.
- `manual_integridade`: FKs compostas multi-tenant, consistência de conversão de lead e trigger de auditoria imutável.
- `manual_supabase_auth_identity`: coluna e índice único para `users.supabaseUserId`.
- `20261125000000_student_payment_method`: enum `PaymentMethod` e coluna `extra_payments.paymentMethod`, com padrão `OTHER`.
- `20261125070000_create_student_workouts`: tabela de exercícios e restrições para valores válidos; preserva o plano ativo mais recentemente atualizado se houver duplicidades antigas e cria índice único parcial para garantir no máximo um treino ativo por aluno.
- `20261125100400_add_weekdays_to_workout_exercises`: enum `Weekday` e coluna anulável `workout_exercises.dayOfWeek`; exercícios antigos ficam sem dia definido e novos planos recebem dias selecionados pelo usuário.

Aplicar migrations versionadas com `npm run prisma:deploy`. Os scripts manuais devem ser executados conforme seus comentários e somente uma vez em cada banco. Não remover as restrições manuais ao gerar diferenças de schema.

## Configuração e comandos

Copie `.env.example` para `.env` e preencha as configurações necessárias. Não versionar segredos:

- `DATABASE_URL`: conexão PostgreSQL.
- `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`: autenticação e inicialização do cliente web.
- `SUPABASE_SECRET_KEY` e `SUPABASE_JWKS_URL`: configurações auxiliares de autenticação quando aplicáveis ao ambiente.
- `TEST_DATABASE_URL`: banco isolado para testes de integração; testes de isolamento limpam o schema alvo.

Comandos definidos no `package.json`:

| Comando | Uso |
| --- | --- |
| `npm run dev` | Inicia API e Vite em conjunto. |
| `npm run build` | Gera a interface para produção em `dist/`. |
| `npm run typecheck` | Executa verificação TypeScript. |
| `npm run prisma:generate` | Gera Prisma Client a partir do schema atual. |
| `npm run prisma:deploy` | Aplica migrations versionadas pendentes. |
| `npm run test:student-payments` | Testa registro e leitura do histórico de pagamentos. |
| `npm run test:workouts` | Testa criação, validação e troca de treino ativo. |
| `npm run test:auth` | Testa autenticação da API. |
| `npm run test:supabase-rest` | Testa o adaptador Supabase REST. |
| `npm run test:isolation` | Executa testes de isolamento multi-tenant no banco de teste configurado. |

## Testes e critérios de aceitação principais

- Pagamentos rejeitam valor inválido, data inexistente, forma desconhecida e aluno inexistente/fora do tenant.
- Um pagamento válido é persistido como confirmado, tem forma e data registradas e aparece no histórico do aluno.
- Receitas confirmadas refletem-se no total mensal e no gráfico de seis meses; a janela inclui pagamentos datados para o dia atual.
- Um treino válido exige aluno ativo e pelo menos um exercício; é criado ativo e desativa o plano ativo anterior do mesmo aluno.
- Cada aluno tem no máximo um plano ativo; desativar ou reativar um treino preserva o histórico e a regra de exclusividade.
- Consultas de um personal não incluem dados de outro.
- Alterações de schema precisam ser acompanhadas da migration correspondente e da regeneração do Prisma Client antes de reiniciar a API.