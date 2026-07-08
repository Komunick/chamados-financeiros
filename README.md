# Brazil Transports — Chamados Financeiros

Sistema de chamados da **Brazil Transports** (visual com a logo e as cores
verde/amarelo de novo.braziltransports.com.br) com dois tipos de chamado:

- **Adiantamento de viagem** — o solicitante informa **veículo**,
  **condutor**, **data da viagem**, **rota** e o **valor total**; o sistema
  calcula o **Adiantamento (70%)** e o **Saldo (30%)**, permite anexar
  **fotos de entrada e saída da viagem** e gera o **lembrete automático de
  pagamento do saldo 5 dias após a confirmação de encerramento da viagem**;
- **Compra** — pedido de compra com **descrição**, **fornecedor** e
  **valor**, pago em **parcela única** pelo financeiro.

Os dados cadastrados são **padronizados**: placa no modelo brasileiro
(ABC-1234) ou Mercosul (ABC1D23), telefone brasileiro com DDD
((00) 90000-0000), CPF com dígitos verificadores validados (000.000.000-00) e
CNH com 11 números — os campos numéricos só aceitam números.

Abas: **Chamados** (em andamento), **Histórico** (finalizados e
cancelados), **Relatórios** e **Notificações**. Os **Relatórios** (visíveis
apenas para quem visualiza os chamados: financeiro/admin) trazem o **total
das viagens e o total das compras**, três listas — **só viagens**, **só
compras** e a **combinada por dia** — além do **valor do dia** e do **valor
futuro** (com destaque para os **próximos 7 dias**): compras contam no dia
da abertura e viagens na **data da viagem**, então viagens agendadas
aparecem marcadas como **futuras**. A aba **Auditoria** (também restrita ao
financeiro) guarda a trilha de **todos os acessos e alterações**: logins
(inclusive tentativas recusadas), abertura de chamados, pagamentos,
encerramentos, cancelamentos, anexos, notificações vistas e gestão de
usuários — cada registro com **usuário, data/hora e IP** (últimos 5.000
eventos). O financeiro é avisado na **barra de tarefas do Windows apenas com
as notificações novas** (cada aviso aparece uma única vez).

Mesma arquitetura do Controle Patrimonial: servidor **Node puro, sem
dependências** (não precisa de `npm install`), dados **fora da pasta web**,
acesso pela rede **ZeroTier**.

## Tech Stack

| Camada | Tecnologia |
|--------|------------|
| **Backend** | Node.js puro (zero dependências npm) |
| **Frontend** | HTML5 + CSS3 + JavaScript vanilla |
| **Banco de dados** | JSON file (`chamados.json`) com gravação atômica + fsync |
| **Tempo real** | Server-Sent Events (SSE) |
| **Autenticação** | `scrypt` + salt, sessões de 30 dias |
| **Notificações desktop** | Balões nativos Windows via PowerShell (`toast-tmp.ps1`) |
| **Rede/VPN** | ZeroTier (`10.13.47.0/24`) + Tailscale (`100.64.0.0/10`) |
| **Automação Windows** | `.bat` (auto-início, firewall) + `.vbs` (execução oculta) |
| **Backup** | Snapshots rotativos a cada 6h (últimos 40 preservados) |

## Pastas

```
opencode\
├── chamados-web\        ← app + servidor (porta 8090)
│   ├── index.html / app.js / styles.css
│   ├── server\server.js + server\db.js
│   ├── start-server.bat        ← inicia o servidor (com loop de reinício)
│   ├── run-hidden.vbs          ← inicia escondido (sem janela)
│   ├── INSTALAR-AUTOINICIO.bat ← servidor sobe sozinho no boot (pede admin)
│   └── LIBERAR-FIREWALL.bat    ← libera a porta 8090 só para o ZeroTier
├── chamados-data\       ← criada sozinha: chamados.json, anexos\, backups\
└── notificador\         ← roda na máquina de QUEM RECEBE os chamados
    ├── notificador.js
    ├── config.json             ← criado na 1ª execução; edite login/senha
    ├── iniciar-notificador.bat
    ├── notificador-oculto.vbs
    └── INSTALAR-NOTIFICADOR.bat ← notificador sobe junto com o Windows
```

## Como colocar no ar (no servidor — este computador)

1. Dê dois cliques em `chamados-web\start-server.bat` (ou `run-hidden.vbs`
   para rodar sem janela). O app fica em:
   - **http://localhost:8090** (local)
   - **http://10.13.47.131:8090** (ZeroTier)
   - **http://100.90.194.59:8090** (Tailscale)
2. Rode `LIBERAR-FIREWALL.bat` uma vez (libera a porta 8090 para ZeroTier e
   Tailscale).
3. Rode `INSTALAR-AUTOINICIO.bat` uma vez para o servidor subir sozinho no boot.
4. Entre com **admin / admin123**, troque a senha e cadastre os usuários em
   **Usuários**:
   - **Solicitante** — quem abre os chamados;
   - **Financeiro** — quem recebe as notificações e registra os pagamentos.

## Como funciona o fluxo

### Chamado de viagem

1. **Solicitante** abre o chamado escolhendo o tipo **Adiantamento de
   viagem** e preenchendo veículo (placa BR/Mercosul, modelo…), **data da
   viagem**, **rota** (ex.: São Paulo → Curitiba), condutor (nome, CPF, CNH,
   telefone — todos com máscara e validação) e o **valor total**. O
   formulário já mostra a prévia do 70/30.
2. O chamado abre com as abas:
   - **Adiantamento e saldo** — Adiantamento (70%) e Saldo (30%), cada um
     com situação Pendente/Pago;
   - **Anexos da viagem** — fotos de **entrada** e de **saída** da viagem.
3. **Financeiro** recebe na hora a notificação com solicitante, veículo,
   condutor, data, rota e valores. Ele marca **Adiantamento pago**.
4. Ao fim da viagem, qualquer um dos dois confirma **Encerramento da viagem**.
5. **5 dias depois**, o sistema gera sozinho o **lembrete de pagamento do
   saldo**, que também vira aviso na barra de tarefas (uma única vez) e fica
   pendente em Notificações até ser marcado como visto.

### Chamado de compra

1. **Solicitante** escolhe o tipo **Compra** e preenche **o que será
   comprado**, o **fornecedor** (opcional) e o **valor** (pagamento único,
   sem 70/30).
2. **Financeiro** recebe a notificação, faz a compra e marca **Compra paga**
   — o chamado é finalizado.
3. Viagens e compras aparecem em **Relatórios** (aba restrita a
   financeiro/admin): totais gerais de cada tipo, lista só de viagens (com
   as **futuras** marcadas pela data da viagem), lista só de compras e a
   lista combinada por dia com o **valor total do dia** e os subtotais de
   viagens e compras. Os cartões do topo mostram o **valor do dia** e o
   **valor futuro dos próximos 7 dias**. Chamados cancelados não somam.

Chamados finalizados ou cancelados saem da lista principal e ficam na aba
**Histórico**, com busca e filtro.

## Notificações na barra de tarefas (máquina do financeiro)

Na máquina de **quem recebe os chamados**, copie a pasta `notificador\` (ou
acesse pela rede) e:

1. Rode `iniciar-notificador.bat` uma vez — ele cria o `config.json`.
2. Edite `config.json`: endereço do servidor (ZeroTier `http://10.13.47.131:8090`
   ou Tailscale `http://100.90.194.59:8090`), `login` e `senha` de um usuário
   **financeiro**.
3. Rode `INSTALAR-NOTIFICADOR.bat` — o notificador passa a iniciar junto com o
   Windows, escondido.

O notificador consulta o servidor a cada 30 s e mostra um **balão nativo do
Windows** (canto da barra de tarefas + central de notificações) com todos os
dados do chamado. Só aparecem as **notificações novas**: cada aviso é exibido
**uma única vez** — o que já foi avisado fica registrado em `avisadas.json`,
então nem reiniciar o notificador repete avisos antigos (na primeira execução,
as notificações já existentes são registradas sem balão). O botão **Abrir
sistema** do balão abre o navegador direto no app. Requisito: Node instalado
na máquina (o mesmo instalador usado no servidor serve).

> Atualizou o notificador? Copie a pasta `notificador\` de novo para a
> máquina do financeiro e reinicie-o para valer a regra de "só novas".

> Observação: notificações de navegador (Chrome/Edge) só funcionam em
> localhost/HTTPS; como o acesso é por IP (http), é o notificador quem garante
> o aviso na barra de tarefas. Dentro do app também aparecem avisos na tela e
> um sino com contador.

## Detalhes técnicos

- Porta **8090** (a 8080 é do Controle Patrimonial). Variáveis: `PORT`, `HOST`,
  `CHAMADOS_DATA_DIR`, `CHAMADOS_LEMBRETE_MS` (encurta os 5 dias em testes).
- Acesso via VPN: **ZeroTier** (`10.13.47.0/24`, `10.71.171.0/24`) e
  **Tailscale** (`100.64.0.0/10`). O `LIBERAR-FIREWALL.bat` libera a porta
  8090 para ambas.
- Dados em `chamados-data\chamados.json` (gravação atômica + fsync); fotos em
  `chamados-data\anexos\<chamado>\`; snapshots rotativos em
  `chamados-data\backups\` (40 mais recentes, a cada 6 h e a cada inicialização).
- Arquivo corrompido → quarentena + servidor aborta (não sobrescreve dados).
- Senhas com `scrypt` + sal por usuário; sessões de 30 dias; bloqueio de 1 min
  após 5 senhas erradas; código do servidor não é servido por HTTP.
- Tempo real por SSE (`/api/events`); fallback de atualização a cada 60 s.
