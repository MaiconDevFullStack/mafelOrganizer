```markdown
# Requisitos — SaaS Agente Inteligente + Organizador Financeiro

## Requisitos Funcionais (FR)

- FR-001: Onboarding self-service de tenants (UC-01) — Prioridade: Alta
- FR-002: Configuração de catálogo de serviços por tenant (UC-01) — Alta
- FR-003: Upload/ingestão de documentos para KB e geração de embeddings por tenant (UC-02) — Alta
- FR-004: Endpoint de conversação em tempo real (REST/WS) multi-canal (UC-03) — Alta
- FR-005: Histórico por conversa e versão da KB (UC-03) — Alta
- FR-006: Escalonamento para atendimento humano com contexto (UC-03) — Alta
- FR-007: Criação/edição de PaymentSchedules (parcelas/recorrência) (UC-04) — Alta
- FR-008: Orquestrador que executa cobranças via PSP/API bancária (UC-05) — Alta
- FR-009: Políticas de retry/dunning configuráveis por tenant (UC-05) — Alta
- FR-010: Emissão de invoice/recibo e envio por e-mail/SMS (UC-05) — Alta
- FR-011: Regras de tarifação/comissão por transação (UC-09) — Média
- FR-012: Integração com múltiplos gateways de pagamento e fallback (UC-10) — Alta
- FR-013: Exportação de dados financeiros (CSV/JSON) e integração ERP (UC-06) — Média
- FR-014: Dashboards e relatórios financeiros (UC-07) — Média
- FR-015: Logs de auditoria imutáveis para ações financeiras (UC-08) — Alta
- FR-016: Webhooks para eventos de PSP (UC-10) — Alta
- FR-017: RBAC (Admin/Finance/Support/Provider) — Alta
- FR-018: gerenciamento de planos/quotas por tenant — Média

### Critérios de aceitação (exemplo)
- Ao criar um `PaymentSchedule`, o serviço retorna 201 e o `schedule` aparece no próximo ciclo do `Scheduler`.
- Quando o `PaymentOrchestrator` recebe resposta 200 do PSP, criar `Transaction` status=success e marcar `Invoice` como PAGA.

## Requisitos Não-Funcionais (NFR)

- NFR-001: Autenticação OAuth2/OpenID Connect; SSO para tenants.
- NFR-002: Conformidade LGPD (consentimento, anonimização, direito ao esquecimento).
- NFR-003: Conformidade PCI-DSS (usar tokenização; não armazenar PANs sem certificação).
- NFR-004: Criptografia TLS 1.2+ e at-rest com KMS.
- NFR-005: SLA base 99.9% (definir por plano) e RPO/RTO por tier.
- NFR-006: Latência do agente: <500ms em cache; timeout ML externo configurável (ex.: 5s).
- NFR-007: Telemetria (traces, métricas) e alerting integrado (Prometheus/Grafana/Jaeger).
- NFR-008: Backups diários com retenção configurável.
- NFR-009: Isolamento lógico por tenant (schema-per-tenant) e opção de infra dedicada.

## Mapeamento (FR → UC)
- FR-001 → UC-01
- FR-003 → UC-02
- FR-004, FR-005, FR-006 → UC-03
- FR-007, FR-008, FR-009 → UC-04 / UC-05

## Observações operacionais
- Usar VectorDB (ex.: Pinecone/Weaviate) para embeddings.
- Preferir tokenização via PSP (Stripe/Adyen) para métodos de pagamento.
- Implementar ambiente `sandbox` para homologação de pagamentos.

## Stack Tecnológico sugerido

- Backend: Node.js (LTS)
- ORM: Sequelize (compatível com PostgreSQL)
- Banco de Dados: PostgreSQL (schema-per-tenant ou row-level com `tenant_id`)
- Frontend: Angular (TypeScript) para integração estruturada entre HTML/CSS e JavaScript
- Alternativamente: aplicações leves em HTML/CSS/JavaScript puro quando não for necessário SPA
- UI Kit: Bootstrap (integração via ngx-bootstrap) e ícones: Font Awesome ou Bootstrap Icons (Glyphicons são parte do Bootstrap 3 apenas)

### Observações sobre integração Angular

- Use `Angular CLI` para scaffolding (`ng new frontend --routing --style=scss`).
- Estruture a aplicação em módulos: `core`, `shared`, `features/conversation`, `features/payments`, `admin`.
- Comunicação com backend: serviço HTTP via `HttpClient` (interceptors para autenticação JWT, retry, error handling).
- Autenticação: implementar fluxo OAuth2/OpenID Connect com `Authorization Code Flow` e `PKCE`; use bibliotecas como `angular-oauth2-oidc` para integração com Keycloak/Auth0.
- Build & deploy: gerar artefatos com `ng build --prod` e servir os arquivos estáticos pelo servidor Node.js (ou CDN). Para desenvolvimento, usar `ng serve` com proxy para backend.
- Componentes de UI: usar `ngx-bootstrap` para componentes Bootstrap nativos em Angular; use `@fortawesome/angular-fontawesome` para ícones.
- Internacionalização: use `@ngx-translate/core` ou o sistema de i18n do Angular para suportar múltiplos idiomas.

- Filas/Jobs: Redis + BullMQ (ou RabbitMQ) para agendamento e processamento de cobranças
- Vector DB / Embeddings: Pinecone / Weaviate
- Autenticação: OAuth2 / OpenID Connect (ex.: Keycloak, Auth0)

## Mapeamento de implementação (exemplos práticos)

- FR-004 (Conversação): `Node.js` + `Express` (ou `Koa`) + `socket.io` para WebSocket; persistência em `Postgres` via `Sequelize`.
- FR-007 (PaymentSchedules): modelar `AgendamentoPagamento` com campos `dataVencimento` e `statusNotificacao` no Postgres; usar `Sequelize` para migrations e modelos.
- FR-008 (Orquestrador): serviço Node.js que consome filas (BullMQ) e faz chamadas a PSPs; grava `Transaction`/`Invoice` em Postgres.
- FR-012 (Gateways): implementar adaptadores em Node.js; armazenar apenas tokens de pagamento (tokenização via PSP) e segredos em cofre (Vault/KMS).
- FR-016 (Webhooks): endpoints em Node.js que validam assinatura do PSP e enfileiram processamento.

## Dependências e pacotes recomendados

- `express` — servidor HTTP
- `socket.io` — WebSocket (se necessário)
- `sequelize` + `pg` — ORM e driver Postgres
- `bullmq` + `ioredis` — filas e agendamentos
- `axios` — chamadas HTTP a PSP/MLProvider
- `winston` ou `pino` — logging estruturado
- `helmet`, `express-rate-limit` — segurança HTTP
- `joi` / `yup` — validação de payloads
- `jest` / `mocha` — testes
- `swagger-ui-express` — documentação OpenAPI

## Scripts iniciais sugeridos (package.json)

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "migrate": "sequelize db:migrate",
    "seed": "sequelize db:seed:all",
    "test": "jest"
  }
}
```

Observação: posso gerar um esqueleto de projeto (backend + migrations Sequelize + scripts) se desejar.

```
