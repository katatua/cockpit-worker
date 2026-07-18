# 20 Apps Agênticas de Produtividade para PME — Specs para o Studio

> **Estado:** specs prontas para aprovação. Só as aprovadas vão para build no **Studio / cockpit-worker** (dogfooding).
> **Legenda leis da suite** aplicadas a cada app: 🔐 = gasto de tokens/dinheiro → **gate biométrico** (WebAuthn) · 🔎 = coleção pesquisável → **pesquisa híbrida (paramétrica + vetorial), tudo embebido** · 🌐 = tem superfície pública → **multi-página + SEO + dark/light** · ♻️ = **reutilizar** app/padrão já existente antes de construir.
> **"Agêntica"** aqui = há um agente/tool que **faz trabalho autónomo** (persegue, decide, redige, monitoriza), não é CRUD passivo.

---

## Grupo A — Finanças & Fiscal (o dinheiro da PME)

### 1. Cobrança Autónoma (AR chaser)
- **Problema PME:** faturas em atraso matam a tesouraria; ninguém tem tempo para perseguir.
- **Agente:** deteta faturas vencidas, redige e envia lembretes **escalonados** (email → SMS → WhatsApp), on-brand e educados→firmes; regista promessas de pagamento; sugere plano de pagamento; para automaticamente quando o cliente paga.
- **Dados:** `faturas`, `clientes`, `interacoes_cobranca`, `promessas_pagamento`.
- **Fluxo:** importa/lê faturas → prioriza por valor×atraso → gera mensagem → envia (com PAUSA de aprovação nos 1ºs dias) → segue resposta → escala.
- **Leis:** 🔐 (envia/gasta) · 🔎 (histórico de clientes) · ♻️ (WhatsApp: reutilizar `whatsapp-webhook` multi-tenant).

### 2. Conciliação Bancária IA
- **Problema:** conciliar extrato ↔ faturas/despesas à mão é horas por mês.
- **Agente:** faz matching automático extrato↔documentos, sinaliza divergências, agrupa, prepara pacote limpo para o contabilista.
- **Dados:** `movimentos_banco`, `faturas`, `despesas`, `conciliacoes`.
- **Fluxo:** importa CSV/OFX do banco → matching (valor+data+referência+semântica) → fila de divergências → aprovação → export.
- **Leis:** 🔐 · 🔎 (matching semântico exige embeddings de descritivos).

### 3. Assistente Fiscal PT (obrigações & prazos)
- **Problema:** IVA, IES, Modelo 22, retenções, DMR — prazos AT que escapam e geram coimas.
- **Agente:** calendário fiscal por tipo de empresa, lembretes escalonados, checklist por obrigação, **estima IVA a pagar/recuperar** do período a partir das faturas.
- **Dados:** `obrigacoes_fiscais`, `prazos`, `faturas`, `regime_empresa`.
- **Fluxo:** perfil fiscal → gera calendário → vigia prazos → alerta com antecedência → checklist de entrega.
- **Leis:** 🔐 · 🌐 (calculadora IVA pública como isca SEO).

### 4. Gestão de Despesas & Reembolsos
- **Problema:** recibos em papel, reembolsos lentos, categorização manual.
- **Agente:** colaborador tira **foto do recibo** → OCR extrai valor/IVA/fornecedor/data → categoriza → fluxo de aprovação → exporta para contabilidade.
- **Dados:** `despesas`, `recibos` (storage), `categorias`, `aprovacoes`.
- **Fluxo:** upload foto → OCR+extração LLM → sugere categoria → aprova → export SAF-T/CSV.
- **Leis:** 🔐 · 🔎 (pesquisa de despesas por fornecedor/categoria/semântica) · ♻️ (**extractor-campos** já faz Drive→checklist→JSON).

### 5. Relatórios de Gestão Automáticos
- **Problema:** o gerente não sabe como está o negócio até o contabilista falar (tarde demais).
- **Agente:** puxa vendas/despesas/tesouraria → gera **dashboard + narrativa mensal** ("o teu negócio este mês") → alertas (margem a cair, cliente concentrado, runway).
- **Dados:** liga-se às fontes das apps 1–4 (ou importa) → `metricas_mensais`.
- **Fluxo:** agrega → calcula KPIs → LLM escreve narrativa → envia resumo.
- **Leis:** 🔐 · ♻️ (padrão BCS/Feed do dashboard bfagentic).

---

## Grupo B — Vendas & Clientes (o crescimento)

### 6. Propostas & Orçamentos Inteligentes
- **Problema:** fazer orçamentos on-brand demora, e depois ninguém segue.
- **Agente:** de um brief/conversa gera **proposta on-brand** com preços de catálogo e margens → envia → segue (aberto/aceite/recusado) → converte aceite em fatura.
- **Dados:** `propostas`, `catalogo`, `clientes`, `eventos_proposta`.
- **Fluxo:** brief → gera → PAUSA revisão → envia (link rastreável) → notifica quando aberta → follow-up.
- **Leis:** 🔐 · 🌐 (proposta é página pública rastreável) · ♻️ (motor de workflows declarativo M7 do BrandForge).

### 7. CRM Leve com Agente de Follow-up
- **Problema:** leads perdem-se; ninguém decide o próximo passo.
- **Agente:** regista leads, **pontua** (scoring), decide próximo passo, redige follow-ups, marca no calendário, avisa quando um lead esfria.
- **Dados:** `leads`, `contactos`, `interacoes`, `pipeline`.
- **Fluxo:** entra lead → scoring → agente propõe ação → redige → aprova/envia → agenda.
- **Leis:** 🔐 · 🔎 (pesquisa híbrida de leads) · ♻️ (padrão de intent scoring do concierge gravitnomad).

### 8. Suporte ao Cliente (inbox agêntico)
- **Problema:** perguntas repetidas em email/WhatsApp/formulário sem controlo de SLA.
- **Agente:** unifica canais, **RAG sobre FAQ/docs da empresa**, rascunha respostas, escala a humano quando incerto, mede SLA.
- **Dados:** `tickets`, `mensagens`, `kb_docs` (embebidos), `sla`.
- **Fluxo:** entra mensagem → classifica → RAG → rascunho → aprova/auto-envia → mede.
- **Leis:** 🔐 · 🔎 (KB embebida — núcleo) · ♻️ (concierge RAG + `whatsapp-webhook`).

### 9. Agendamento & Reservas com Agente
- **Problema:** marcações por telefone/DM, no-shows, agenda desorganizada.
- **Agente:** cliente marca via chat/WhatsApp, agente confere disponibilidade, confirma, envia lembretes, **reagenda no-shows** automaticamente.
- **Dados:** `servicos`, `disponibilidade`, `reservas`, `lembretes`.
- **Fluxo:** pedido → slots livres → confirma → lembrete D-1/H-2 → no-show → reoferta.
- **Leis:** 🔐 · 🌐 (página pública de reserva por negócio) · ♻️ (WhatsApp multi-tenant).

### 10. Marketing de Conteúdo (calendário social leve)
- **Problema:** PME sem tempo/marca para publicar consistentemente.
- **Agente:** plano editorial mensal → gera posts on-brand (texto + imagem) → agenda → mede.
- **Dados:** `plano_editorial`, `posts`, `metricas_social`.
- **Fluxo:** tema/objetivo → calendário → gera lote → PAUSA revisão → agenda/publica.
- **Leis:** 🔐 · 🌐 · ♻️ (**BrandForge** já faz isto a fundo — esta é a versão PME *leve*; avaliar se vale ou se se redireciona para BrandForge).

---

## Grupo C — Operações (o dia-a-dia)

### 11. Gestão de Compras & Fornecedores
- **Problema:** cotações por email disperso, sem comparação, sem rasto.
- **Agente:** dispara pedidos de cotação a vários fornecedores, **compara** propostas (preço/prazo/condições), sugere melhor, gera ordem de compra, segue entregas.
- **Dados:** `fornecedores`, `cotacoes`, `ordens_compra`, `entregas`.
- **Fluxo:** necessidade → RFQ multi-fornecedor → recolhe → compara → recomenda → OC → tracking.
- **Leis:** 🔐 · 🔎 (histórico de fornecedores/preços).

### 12. Inventário / Stock Inteligente
- **Problema:** ruturas e excesso de stock, reposição por instinto.
- **Agente:** **prevê ruturas** com base em consumo, alerta stock baixo, sugere quantidade de reposição, gera OC (liga à app 11).
- **Dados:** `produtos`, `movimentos_stock`, `previsoes`, `alertas`.
- **Fluxo:** consumo histórico → previsão → alerta → sugestão de compra.
- **Leis:** 🔐 · 🔎.

### 13. Gestão de Projetos/Tarefas com IA
- **Problema:** objetivos que não viram tarefas; sem ponto de situação.
- **Agente:** decompõe objetivo em tarefas, atribui, estima prazos, **deteta bloqueios**, resume ponto de situação semanal.
- **Dados:** `projetos`, `tarefas`, `atribuicoes`.
- **Fluxo:** objetivo → decomposição LLM → board → agente vigia atrasos → resumo.
- **Leis:** 🔐 · ♻️ (**reutilizar `kanban-projetos` / `todos` / `tarefas`** — regra dura, não duplicar Kanban).

### 14. Gestão de Frota & Manutenção
- **Problema:** IUC, seguros, inspeção periódica, manutenções — datas que escapam.
- **Agente:** agenda inspeções/manutenções, alerta seguro/IUC/inspeção, custo por viatura.
- **Dados:** `viaturas`, `manutencoes`, `alertas_legais`, `custos`.
- **Fluxo:** frota → calendário de obrigações → alertas → registo de custos.
- **Leis:** 🔐 · 🔎.

### 15. Gestão de Contratos
- **Problema:** contratos em pastas, renovações silenciosas, riscos por ler.
- **Agente:** **extrai cláusulas-chave** (renovação, denúncia, valor, penalizações), alerta prazos de renovação/denúncia, resume riscos.
- **Dados:** `contratos` (storage + embeddings), `clausulas`, `alertas`.
- **Fluxo:** upload → extração LLM → indexa → vigia datas → alerta com antecedência.
- **Leis:** 🔐 · 🔎 (pesquisa semântica de cláusulas — núcleo).

---

## Grupo D — Pessoas / RH

### 16. Recrutamento Express (triagem de CV)
- **Problema:** dezenas de CVs, triagem manual lenta e enviesada.
- **Agente:** faz **scoring de CVs** vs job description, gera perguntas de entrevista, agenda (calendário), resume cada candidato.
- **Dados:** `vagas`, `candidatos` (CV embebido), `avaliacoes`, `entrevistas`.
- **Fluxo:** vaga → recebe CVs → scoring → shortlist → agenda → resumo.
- **Leis:** 🔐 · 🔎 (matching CV↔vaga por embeddings) · 🌐 (página pública da vaga + candidatura).

### 17. Onboarding de Colaborador
- **Problema:** entradas caóticas (contrato, equipamento, acessos, formação).
- **Agente:** gera **checklist automática** por função, dispara tarefas aos responsáveis (IT, RH, chefia) e **persegue** os atrasados.
- **Dados:** `colaboradores`, `checklists`, `tarefas_onboarding`.
- **Fluxo:** novo colaborador → template por função → tarefas → agente cobra pendentes → conclui.
- **Leis:** 🔐 · ♻️ (reutilizar motor de tarefas da app 13).

### 18. Base de Conhecimento Interna (RAG)
- **Problema:** "onde está a política de X?" — conhecimento na cabeça de 1 pessoa.
- **Agente:** responde perguntas dos colaboradores sobre políticas/procedimentos, indexando docs internos; sinaliza docs desatualizados.
- **Dados:** `kb_docs` (embebidos), `perguntas`, `gaps_conhecimento`.
- **Fluxo:** ingestão de docs → embeddings → pergunta → RAG → resposta com fonte.
- **Leis:** 🔐 · 🔎 (núcleo) · ♻️ (leitor de sites/ingestão + escada de ingestão barata→cara).

---

## Grupo E — Conhecimento, Compliance & Mercado

### 19. Assistente RGPD / Jurídico para PME
- **Problema:** PME sem jurista; RGPD e contratos-tipo por fazer.
- **Agente:** gera/revê **documentos base** (contratos-tipo, política de privacidade, RGPD, NDA), checklist de conformidade RGPD.
- **Dados:** `templates_juridicos`, `documentos_gerados`, `checklist_rgpd`.
- **Fluxo:** escolhe tipo → responde perguntas → gera doc → checklist → export.
- **Leis:** 🔐 · 🔎 · ⚠️ *disclaimer: não é aconselhamento jurídico* (paralelo à regra de não dar conselho financeiro personalizado).

### 20. Monitor de Concorrência / Mercado
- **Problema:** PME cega ao que os concorrentes fazem (preços, novidades).
- **Agente:** monitoriza sites/preços/notícias de concorrentes, **resume mudanças semanais**, alerta a mudanças relevantes.
- **Dados:** `concorrentes`, `snapshots`, `mudancas`, `alertas`.
- **Fluxo:** lista concorrentes → ingestão periódica (cron) → diff → resumo LLM → alerta.
- **Leis:** 🔐 · 🔎 · ♻️ (**escada de ingestão** fetch→Jina→Playwright→Firecrawl; regra dura de custo).

---

## Transversal a TODAS (leis da suite, não repetir por app)
- **Login biométrico** (WebAuthn) obrigatório antes de qualquer ação que gaste tokens/dinheiro (🔐). Páginas públicas ficam públicas.
- **Pesquisa híbrida + embeddings** em toda a coleção pesquisável (🔎). Nada de LIKE.
- **Multi-página + SEO + dark/light com toggle** (default light em produção, dark só em localhost) para toda a superfície pública (🌐).
- **APIs M2M consultáveis** (token para máquinas OU sessão para o dono) para todos os dados úteis.
- **x402-ready** (aceitar e consumir pagamentos por chamada).
- **Opções clicáveis no chat** (single = auto-envia; múltipla = checkboxes + confirmar).

## Reutilizar antes de construir (candidatos já no ecossistema)
| App | Reutiliza |
|---|---|
| 1, 8, 9 | `whatsapp-webhook` multi-tenant + concierge RAG |
| 4 | `extractor-campos` (Drive→JSON) |
| 6 | motor de workflows declarativo M7 (BrandForge) |
| 7, 20 | intent scoring + escada de ingestão (gravitnomad/site-reader) |
| 10 | **BrandForge** (decidir: versão leve vs redirecionar) |
| 13, 17 | `kanban-projetos` / `todos` / `tarefas` |
| 18, 20 | leitor de sites robusto + escada de ingestão barata→cara |

## Priorização sugerida (quick wins primeiro)
- **Top 5 (ROI + rápido):** 1 Cobrança · 6 Propostas · 8 Suporte · 9 Agendamento · 3 Fiscal PT.
- **Top 10:** + 4 Despesas · 7 CRM · 13 Projetos · 16 Recrutamento · 18 KB interna.
- **Restantes 10:** 2, 5, 10, 11, 12, 14, 15, 17, 19, 20.
