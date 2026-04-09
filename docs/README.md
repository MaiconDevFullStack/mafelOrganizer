# Documentação do SaaS: Agente Inteligente + Financeiro

Este diretório contém os diagramas UML (PlantUML) e a documentação de requisitos para a plataforma SaaS multitenant.

- Diagramas PlantUML: `plantuml/`
- Requisitos detalhados: `requirements.md`

Arquivos gerados:

- `plantuml/use_case.puml` — Diagrama de Casos de Uso
- `plantuml/class_diagram.puml` — Diagrama de Classes (domínio)
- `plantuml/sequence_agendamento.puml` — Sequência: Agendamento de Pagamento
- `plantuml/sequence_cobranca.puml` — Sequência: Execução de Cobrança
- `requirements.md` — Requisitos funcionais e não-funcionais (PT-BR)
- `openapi/payments_openapi.yaml` — Skeleton OpenAPI para pagamentos e conversação

Arquivos gerados (PNG):

- `plantuml/use_case.png` — Diagrama de Casos de Uso
  
	![Use Case](plantuml/use_case.png)

- `plantuml/class_diagram.png` — Diagrama de Classes (domínio)
  
	![Class Diagram](plantuml/class_diagram.png)

- `plantuml/sequence_agendamento.png` — Sequência: Agendamento de Pagamento
  
	![Sequência Agendamento](plantuml/sequence_agendamento.png)

- `plantuml/sequence_cobranca.png` — Sequência: Execução de Cobrança
  
	![Sequência Cobrança](plantuml/sequence_cobranca.png)

SVGs podem ser gerados mediante solicitação (use `-tsvg` com o comando Docker ou troque o endpoint PlantUML para `/plantuml/svg/`).

Visualizar no yUML
------------------

Adicionei versões em yUML dos diagramas (para colar diretamente em https://yuml.me/):

- `yuml/use_case.yuml` — Casos de Uso (formato yUML)
- `yuml/class_diagram.yuml` — Diagrama de Classes (formato yUML)
- `yuml/sequence_agendamento_activity.yuml` — Fluxo de atividade (versão yUML da sequência de agendamento)
- `yuml/sequence_cobranca_activity.yuml` — Fluxo de atividade (versão yUML da sequência de cobrança)

Nota importante sobre agendamento e notificações:

- Nos diagramas de agendamento, o **Prestador** cadastra a `dataVencimento` do pagamento; o **Sistema** então notifica automaticamente o `Cliente` (notificações de agendamento, lembretes e avisos de tentativa/resultado de cobrança).
- No diagrama de classes (`yuml/class_diagram.yuml`) o elemento `AgendamentoPagamento` inclui agora os atributos `dataVencimento` e `statusNotificacao`.

Como usar:

1) Acesse https://yuml.me/ e cole o conteúdo do arquivo desejado no campo "yUML text".
2) Escolha o estilo (diagrama de classes ou activity) conforme apropriado e clique em "Draw Diagram".

Observação: o yUML não suporta diagramas de sequência detalhados; por isso gerei fluxos de atividade simplificados para as sequências.

Como gerar PNG/SVG a partir dos PlantUML e validar OpenAPI:

1) Com o `plantuml` (local) ou usando Docker:

```bash
# Usando Docker (recomendado se não tiver plantuml local)
docker run --rm -v "$PWD":/workspace -w /workspace plantuml/plantuml:latest \
	-tpng docs/plantuml/use_case.puml

# gerar todos os .puml para PNG
docker run --rm -v "$PWD":/workspace -w /workspace plantuml/plantuml:latest \
	-tpng docs/plantuml/*.puml
```

2) Gerar SVG trocando `-tpng` por `-tsvg`.

3) Validar o OpenAPI (instale `swagger-cli` ou `openapi-cli`):

```bash
# com npm (se necessário)
npm install -g @apidevtools/swagger-cli
swagger-cli validate docs/openapi/payments_openapi.yaml
```

4) Exportar OpenAPI para JSON (opcional):

```bash
swagger-cli bundle docs/openapi/payments_openapi.yaml --outfile docs/openapi/payments_openapi.json --type json
```

Próximos passos sugeridos:

- Gerar arquivos PNG/SVG a partir dos `.puml` com PlantUML.
- Gerar OpenAPI skeleton para endpoints críticos (pagamentos, conversação).
- Exportar documento final em PDF/Markdown.

Se desejar, gero o OpenAPI e exporto os PNGs agora.
