// ============================================================
// sincronizarHistoricoFuturos.js — RECONSTRUÇÃO DE ESTADO A PARTIR DO
// HISTÓRICO DA BINANCE (fonte única da verdade).
// ------------------------------------------------------------
// POR QUE ESTE ARQUIVO EXISTE.
//
// Até aqui o robô se recuperava olhando POSIÇÕES ABERTAS (positionRisk):
// se a posição sumiu, o slot virava fantasma e era apagado. Esse modelo é
// cego para tudo que ACONTECEU — ele vê o estoque, não o extrato. Não
// sabe a que preço a posição saiu, quanto realizou, se foi stop, alvo,
// liquidação ou mão humana no app. Pior: um restart no meio de um ciclo,
// ou uma proteção que disparou na corretora enquanto o processo estava
// morto, deixavam o banco local mentindo para sempre — e é o banco que
// alimenta PnL, placar do dia, meta e trava de risco.
//
// Aqui a régua inverte: o extrato de execução da Binance (`userTrades`) é
// a verdade, e o SQLite é uma PROJEÇÃO dele. Toda rodada relê a janela,
// reconstrói os ciclos de posição fill a fill e reescreve o banco de forma
// IDEMPOTENTE — rodar 1 vez ou 100 vezes produz exatamente o mesmo estado.
//
// COMO UM CICLO É RECONSTRUÍDO.
//
// Futuros não tem "compra" e "venda": tem posição com SINAL. Percorremos
// os fills em ordem cronológica mantendo a quantidade líquida acumulada:
//
//   posição 0 -> != 0   : ABRE ciclo. BUY abre LONG, SELL abre SHORT.
//   mesmo sinal         : AUMENTA (a média de entrada se move).
//   sinal contrário     : REDUZ (saída parcial ou total, realiza PnL).
//   cruza o zero        : FECHA o ciclo e ABRE outro na direção oposta —
//                         o fill é DIVIDIDO proporcionalmente entre os dois.
//   volta a 0           : FECHA o ciclo.
//
// A SEMENTE DO LOOP (detalhe que faz a coisa toda funcionar). A janela de
// 24h corta ciclos ao meio: uma posição aberta ontem e fechada hoje tem os
// fills de ENTRADA fora da janela, e o primeiro fill visível seria uma
// redução de uma posição que "não existe" — reconstruída ingenuamente,
// viraria um SHORT fantasma. A posição inicial da janela é recuperada por
// identidade, não por chute:
//
//     posInicial = posiçãoAtualNaCorretora − Σ(deltas dos fills da janela)
//
// e o preço de entrada dessa parte herdada é DERIVADO do realizedPnl que a
// própria Binance informa em cada fill de saída:
//
//     entrada = saída − sinal * (pnlRealizado / quantidade)
//
// ou seja, mesmo sem ver a ordem de abertura, o preço de entrada sai
// exato. Nada aqui é estimado.
//
// MARGEM × NOTIONAL. `invested_usdt` do banco guarda a MARGEM (o dinheiro
// que saiu da banca), não o notional. O extrato dá notional; a divisão
// pela alavancagem real da posição acontece aqui, num único lugar. E
// `pnl_percent` é ROI SOBRE A MARGEM — a mesma régua dos alvos de 8%.
//
// O QUE ESTE MÓDULO NÃO FAZ: não posta ordem, não fecha posição, não
// cancela nada. É estritamente leitura da corretora + escrita no SQLite.
// Recuperação de proteção continua sendo trabalho da auditoria anti-nudez.
// ============================================================
const fut = require('./futuresApi');
const dbApi = require('../db');

// ------------------------------------------------------------
// Parâmetros
// ------------------------------------------------------------
// Janela de sincronização pedida: as últimas 24h de movimentação.
const JANELA_PADRAO_MS = 24 * 60 * 60 * 1000;
// Recuo EXTRA de leitura, além da janela. Serve só para achar as ENTRADAS
// de ciclos que fecharam dentro da janela mas nasceram antes dela. Não
// gera escrita própria: ciclo inteiramente fora da janela é ignorado.
const LOOKBACK_EXTRA_MS = 24 * 60 * 60 * 1000;
// Tolerância para casar um ciclo da corretora com a linha que o próprio
// motor gravou (o relógio local e o da Binance não são o mesmo, e o
// INSERT local acontece milissegundos depois do fill).
const MATCH_JANELA_MS = 5 * 60 * 1000;
// Pausa entre símbolos. userTrades pesa 5 e allOrders pesa 5; com dezenas
// de pares numa rodada isso vira rajada. 250ms mantém a rodada longe do
// limite de peso por minuto sem tornar o boot lento.
const DELAY_SIMBOLO_MS = 250;
// Teto de páginas do extrato (income). Cada página traz 1000 lançamentos;
// 10 páginas cobrem qualquer dia real deste robô com folga.
const MAX_PAGINAS_INCOME = 10;
// Alavancagem usada quando a corretora não informa a da posição
// (/fapi/v3/positionRisk nem sempre devolve `leverage`) e não há registro
// local de onde inferir.
const ALAVANCAGEM_PADRAO = parseInt(process.env.FUT_ALAVANCAGEM || '3', 10);

// Lock de instância: boot e tick periódico podem coincidir. Duas rodadas
// simultâneas não corromperiam o banco (o índice único em ciclo_id
// impede), mas gastariam peso de API à toa e embaralhariam o log.
let emAndamento = false;
// Instante da última rodada concluída com sucesso (exposto no relatório e
// consumido pelo painel para saber se o número exibido é recente).
let ultimaSincronizacaoMs = 0;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// ============================================================
// DESCOBERTA DE SÍMBOLOS
// ------------------------------------------------------------
// `userTrades` EXIGE symbol — não existe "me dê todos os fills da conta".
// Varrer os ~300 perpétuos a cada rodada seria inviável em peso de API.
// O extrato (`/fapi/v1/income`) resolve: ele é global, custa 30 de peso e
// diz exatamente quais pares tiveram movimento na janela. As outras três
// fontes cobrem o que o extrato não veria:
//   - posições abertas AGORA (podem não ter realizado nada ainda);
//   - active_slots local (o slot pode ser fantasma — precisa ser auditado);
//   - trade_history recente (para corrigir o que já foi gravado).
// ============================================================
async function descobrirSimbolos({ inicio, fim, ignorar }) {
  const simbolos = new Set();
  const origens = { income: 0, posicoes: 0, slots: 0, historico: 0 };

  // 1) Extrato da conta — paginado por tempo.
  try {
    let cursor = inicio;
    for (let pagina = 0; pagina < MAX_PAGINAS_INCOME; pagina += 1) {
      const linhas = await fut.income({ startTime: cursor, endTime: fim });
      for (const l of linhas) {
        if (l.symbol) {
          if (!simbolos.has(l.symbol)) origens.income += 1;
          simbolos.add(l.symbol);
        }
      }
      if (linhas.length < 1000) break;
      const ultimo = Math.max(...linhas.map((l) => Number(l.time) || 0));
      if (!ultimo || ultimo <= cursor) break;   // sem avanço: corta o loop
      cursor = ultimo + 1;
    }
  } catch (err) {
    console.error(`[SYNC-HIST] Falha ao ler o extrato (income): ${fut.detalheErro(err)}`);
  }

  // 2) Posições abertas na corretora.
  let posicoes = [];
  try {
    posicoes = await fut.todasPosicoes();
    for (const p of posicoes) {
      if (!simbolos.has(p.symbol)) origens.posicoes += 1;
      simbolos.add(p.symbol);
    }
  } catch (err) {
    console.error(`[SYNC-HIST] Falha ao ler posições abertas: ${fut.detalheErro(err)}`);
    // Sem posições não dá para reconstruir a semente da janela nem
    // decidir sobre slots fantasmas: propaga para a rodada abortar.
    throw err;
  }

  // 3) Slots locais.
  const slots = await dbApi.getActiveSlots();
  for (const s of slots) {
    if (!simbolos.has(s.symbol)) origens.slots += 1;
    simbolos.add(s.symbol);
  }

  // 4) Histórico recém-gravado.
  const historico = await dbApi.getHistorySince(inicio);
  for (const h of historico) {
    if (!simbolos.has(h.symbol)) origens.historico += 1;
    simbolos.add(h.symbol);
  }

  for (const s of ignorar) simbolos.delete(s);

  return { simbolos: [...simbolos].sort(), posicoes, slots, origens };
}

// ============================================================
// TAXAS. Em Futuros a comissão quase sempre vem em USDT, mas a conta pode
// estar com "pagar taxas em BNB" ligado — e aí a comissão sai em BNB.
// Ignorar isso subestima o custo de todo trade do dia.
// ============================================================
function taxaEmUSDT(fill, precoBNB) {
  const valor = num(fill.commission);
  if (valor <= 0) return 0;
  const ativo = fill.commissionAsset;
  if (ativo === 'USDT') return valor;
  if (ativo === 'BNB') {
    if (precoBNB > 0) return valor * precoBNB;
    console.warn(`[SYNC-HIST] Taxa em BNB (${valor}) sem preço de referência — não convertida.`);
    return 0;
  }
  // Comissão no ativo base do par: converte pelo preço do próprio fill.
  const base = String(fill.symbol || '').replace(/USDT$/, '');
  if (ativo === base) return valor * num(fill.price);
  console.warn(`[SYNC-HIST] Taxa em ${ativo} (${valor}) ignorada na conversão p/ USDT.`);
  return 0;
}

// ============================================================
// RECONSTRUÇÃO DOS CICLOS
// ------------------------------------------------------------
// fills   : userTrades do símbolo, em ordem cronológica.
// posFinal: positionAmt ASSINADO da corretora AGORA (0 = sem posição).
//           É o que permite calcular a posição no início da janela.
// ============================================================
function reconstruirCiclos(symbol, fills, posFinal, precoBNB) {
  const ciclos = [];
  if (fills.length === 0) return ciclos;

  // Delta líquido dos fills da janela e escala para o epsilon de "zero".
  let deltaTotal = 0;
  let maiorQty = 0;
  for (const f of fills) {
    const q = num(f.qty);
    deltaTotal += (f.side === 'BUY' ? q : -q);
    if (q > maiorQty) maiorQty = q;
  }
  // Quantidades vêm com o stepSize do par (podem ser 0.001 ou 100000).
  // Um epsilon absoluto fixo classificaria errado em algum dos extremos.
  const EPS = Math.max(maiorQty * 1e-9, 1e-12);

  // SEMENTE: posição que já existia quando a janela começou.
  let pos = posFinal - deltaTotal;
  if (Math.abs(pos) < EPS) pos = 0;

  const novoCiclo = (direcao, herdado, fill) => ({
    symbol,
    direcao,                    // 'LONG' | 'SHORT'
    herdado,                    // true = entrada anterior à janela lida
    qtyEntrada: 0,              // quantidade que entrou (só fills vistos)
    quoteEntrada: 0,            // Σ preço*qty da entrada (notional)
    feeEntrada: 0,
    qtySaida: 0,
    quoteSaida: 0,
    feeSaida: 0,
    pnlBruto: 0,                // Σ realizedPnl dos fills de saída
    entradaOrderIds: new Set(),
    saidaOrderIds: new Set(),
    primeiroFillEntrada: fill ? Number(fill.id) : null,
    primeiroFillSaida: null,
    inicio: fill ? Number(fill.time) : null,
    fim: null,
    aberto: false,
    qtyRestante: 0
  });

  const aplicarEntrada = (ciclo, fill, qtyParte) => {
    ciclo.qtyEntrada += qtyParte;
    ciclo.quoteEntrada += num(fill.price) * qtyParte;
    ciclo.feeEntrada += taxaEmUSDT(fill, precoBNB) * (qtyParte / num(fill.qty));
    ciclo.entradaOrderIds.add(String(fill.orderId));
    if (ciclo.primeiroFillEntrada == null) ciclo.primeiroFillEntrada = Number(fill.id);
    if (ciclo.inicio == null) ciclo.inicio = Number(fill.time);
  };

  const aplicarSaida = (ciclo, fill, qtyParte) => {
    const fracao = qtyParte / num(fill.qty);
    ciclo.qtySaida += qtyParte;
    ciclo.quoteSaida += num(fill.price) * qtyParte;
    ciclo.feeSaida += taxaEmUSDT(fill, precoBNB) * fracao;
    // realizedPnl vem POR FILL e já é líquido de preço (bruto de taxa).
    // Rateado pela fração quando o fill cruza o zero e alimenta dois ciclos.
    ciclo.pnlBruto += num(fill.realizedPnl) * fracao;
    ciclo.saidaOrderIds.add(String(fill.orderId));
    if (ciclo.primeiroFillSaida == null) ciclo.primeiroFillSaida = Number(fill.id);
    ciclo.fim = Number(fill.time);
  };

  // Ciclo herdado: a posição existia antes do primeiro fill lido. Direção
  // vem do sinal da semente; preço de entrada será DERIVADO do realizedPnl
  // na hora de montar o registro (ver precoEntradaDe).
  let ciclo = null;
  if (pos !== 0) {
    ciclo = novoCiclo(pos > 0 ? 'LONG' : 'SHORT', true, null);
    ciclo.qtyEntrada = Math.abs(pos);
  }

  for (const fill of fills) {
    const qty = num(fill.qty);
    if (qty <= 0) continue;
    const sinal = fill.side === 'BUY' ? 1 : -1;
    let restante = qty;

    // (a) Parte do fill que REDUZ a posição corrente.
    if (ciclo && pos !== 0 && Math.sign(pos) !== sinal) {
      const reduz = Math.min(restante, Math.abs(pos));
      aplicarSaida(ciclo, fill, reduz);
      pos += sinal * reduz;
      restante -= reduz;
      if (Math.abs(pos) < EPS) {
        pos = 0;
        ciclos.push(ciclo);
        ciclo = null;
      }
    }

    // (b) O que sobra ABRE ou AUMENTA posição. Sobra depois de zerar =
    //     inversão de direção no mesmo fill (BUY que fecha um SHORT e
    //     ainda abre um LONG) — o fill já foi rateado entre os dois.
    if (restante > EPS) {
      if (!ciclo) ciclo = novoCiclo(sinal > 0 ? 'LONG' : 'SHORT', false, fill);
      aplicarEntrada(ciclo, fill, restante);
      pos += sinal * restante;
    }
  }

  if (ciclo) {
    ciclo.aberto = true;
    ciclo.qtyRestante = Math.abs(pos);
    ciclos.push(ciclo);
  }

  // CONFERÊNCIA DA RECONSTRUÇÃO: o fim do passeio tem que bater com a
  // posição real. Se não bate, a semente estava errada (fills faltando por
  // limite de paginação, por exemplo) e o resultado é marcado como
  // suspeito em vez de virar escrita silenciosa no banco.
  const conferido = Math.abs(pos - posFinal) < Math.max(EPS, Math.abs(posFinal) * 1e-6);
  if (!conferido) {
    console.warn(
      `[SYNC-HIST] ${symbol}: reconstrução fechou em ${pos} mas a corretora diz ${posFinal}. ` +
      'Ciclos marcados como não conferidos.'
    );
    for (const c of ciclos) c.suspeito = true;
  }

  return ciclos;
}

// Preço médio de entrada do ciclo.
// Caso normal: média ponderada dos fills de entrada.
// Ciclo herdado (entrada fora da janela lida): DERIVADO do PnL realizado —
//   pnl = (saída − entrada) * qty * sinal  =>  entrada = saída − sinal*pnl/qty
// Isso é exato, não uma estimativa: realizedPnl é o número da corretora.
function precoEntradaDe(ciclo) {
  const vistoQty = ciclo.qtyEntrada > 0 ? ciclo.qtyEntrada : 0;
  const vistoQuote = ciclo.quoteEntrada;
  if (!ciclo.herdado && vistoQty > 0) return vistoQuote / vistoQty;

  if (ciclo.qtySaida > 0) {
    const precoSaida = ciclo.quoteSaida / ciclo.qtySaida;
    const sinal = ciclo.direcao === 'LONG' ? 1 : -1;
    const derivado = precoSaida - sinal * (ciclo.pnlBruto / ciclo.qtySaida);
    if (Number.isFinite(derivado) && derivado > 0) return derivado;
  }
  // Herdado e ainda ABERTO: sem saída não há PnL realizado de onde
  // derivar. Quem chama cobre esse caso com o entryPrice da posição.
  return vistoQty > 0 ? vistoQuote / vistoQty : 0;
}

// ============================================================
// MOTIVO DO FECHAMENTO. Os fills não dizem por que a posição fechou; as
// ORDENS dizem. Uma chamada a allOrders por símbolo (peso 5) e o mapa
// orderId -> tipo classifica todas as saídas do par.
//
// Cuidado com liquidação: a Binance a representa como ordem comum com
// clientOrderId prefixado ('autoclose-' = liquidação, 'adl_autoclose' =
// desalavancagem automática). Chamar isso de "MERCADO" esconderia o
// evento mais grave que pode acontecer com o robô.
// ============================================================
function classificarSaida(ordem, pnlUSDT) {
  if (!ordem) return pnlUSDT >= 0 ? 'SYNC_SAIDA_LUCRO' : 'SYNC_SAIDA_PREJUIZO';

  const cid = String(ordem.clientOrderId || '');
  if (cid.startsWith('autoclose-')) return 'LIQUIDACAO';
  if (cid.startsWith('adl_autoclose')) return 'ADL';

  const tipo = String(ordem.origType || ordem.type || '').toUpperCase();
  switch (tipo) {
    case 'STOP_MARKET':
    case 'STOP':
      return 'SL_BINANCE';
    case 'TAKE_PROFIT_MARKET':
    case 'TAKE_PROFIT':
      return 'TP_BINANCE';
    case 'TRAILING_STOP_MARKET':
      return 'TRAILING_BINANCE';
    case 'LIQUIDATION':
      return 'LIQUIDACAO';
    case 'MARKET':
      return 'MERCADO_BINANCE';
    case 'LIMIT':
      return 'LIMITE_BINANCE';
    default:
      return tipo ? `BINANCE_${tipo}` : (pnlUSDT >= 0 ? 'SYNC_SAIDA_LUCRO' : 'SYNC_SAIDA_PREJUIZO');
  }
}

// Alavancagem aplicável ao ciclo, em ordem de confiança:
//   1. a que a corretora informa para a posição aberta;
//   2. a inferida do registro local (notional/margem gravados na entrada);
//   3. a global do .env.
function alavancagemDe(posicao, registroLocal) {
  const daCorretora = posicao && Number(posicao.alavancagem);
  if (Number.isFinite(daCorretora) && daCorretora > 0) return daCorretora;

  if (registroLocal) {
    const margem = num(registroLocal.invested_usdt);
    const notional = num(registroLocal.buy_price) * num(registroLocal.quantity);
    if (margem > 0 && notional > 0) {
      const inferida = Math.round(notional / margem);
      if (inferida >= 1 && inferida <= 125) return inferida;
    }
  }
  return ALAVANCAGEM_PADRAO;
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ------------------------------------------------------------
// opts:
//   janelaMs        janela sincronizada (default 24h)
//   lookbackExtraMs recuo extra só de leitura (default 24h)
//   origem          rótulo para o log ('boot', 'tick 15min', 'manual')
//   ignorar         Set/array de símbolos a pular (entradas em voo, vendas
//                   em andamento: o motor está no meio de uma escrita e o
//                   extrato ainda não a reflete)
//   dryRun          apura tudo e NÃO escreve no banco
//   removerFantasmas  apaga slot local quando a corretora está zerada e
//                   não há ciclo fechado explicando a saída (default false:
//                   apagar sem prova é perder o registro da operação)
//   onMudanca       callback async chamado ao fim se houve escrita
// ============================================================
async function sincronizarHistoricoFuturos(opts = {}) {
  const origem = opts.origem || 'manual';

  if (emAndamento) {
    console.log(`[SYNC-HIST] Rodada ignorada (${origem}): já existe uma em andamento.`);
    return { ok: false, ignorada: true, motivo: 'rodada em andamento', origem };
  }
  emAndamento = true;

  const t0 = Date.now();
  const janelaMs = Number(opts.janelaMs) > 0 ? Number(opts.janelaMs) : JANELA_PADRAO_MS;
  const lookbackExtraMs = Number.isFinite(opts.lookbackExtraMs)
    ? Number(opts.lookbackExtraMs)
    : LOOKBACK_EXTRA_MS;
  const dryRun = !!opts.dryRun;
  const ignorar = new Set(opts.ignorar || []);

  // ----------------------------------------------------------
  // PISO DO MARCO ZERO (2026-07-28).
  // O marco zero redefine a banca inicial, mas a Binance não sabe disso:
  // ela continua devolvendo os fills das últimas 24h. Sem um piso, apagar
  // trade_history era inútil — a rodada seguinte (boot, tick de 15 min ou
  // Hard Sync) reimportava tudo da corretora e as estatísticas antigas
  // voltavam sozinhas, que é exatamente o que o operador viu acontecer.
  //
  // `pisoMs` é a data de nascimento do ciclo atual: NADA que fechou antes
  // dela entra em trade_history, por mais que apareça no extrato. Ciclos
  // ABERTOS não são filtrados — uma posição viva precisa virar slot,
  // tenha ela nascido quando for.
  // ----------------------------------------------------------
  const pisoMs = Number(opts.pisoMs) > 0 ? Number(opts.pisoMs) : 0;

  const fim = Date.now();
  const inicioJanela = Math.max(fim - janelaMs, pisoMs);
  const inicioBusca = (fim - janelaMs) - lookbackExtraMs;

  const rel = {
    ok: true,
    origem,
    dryRun,
    janela: {
      de: new Date(inicioJanela).toISOString(),
      ate: new Date(fim).toISOString(),
      lidoDesde: new Date(inicioBusca).toISOString()
    },
    simbolos: 0,
    ciclosFechados: 0,
    ciclosAbertos: 0,
    inseridos: 0,
    atualizados: 0,
    adotados: 0,
    slotsInseridos: 0,
    slotsAtualizados: 0,
    slotsRemovidos: 0,
    ignorados: [...ignorar],
    alertas: [],
    erros: [],
    duracaoMs: 0
  };

  try {
    console.log(
      `[SYNC-HIST] Início (${origem}). Janela de ${(janelaMs / 3600000).toFixed(1)}h ` +
      `(leitura desde ${new Date(inicioBusca).toLocaleString('pt-BR')})` +
      (pisoMs > 0
        ? ` | PISO do marco zero em ${new Date(pisoMs).toLocaleString('pt-BR')} ` +
          '— nada anterior entra no histórico'
        : '') +
      `${dryRun ? ' [DRY-RUN]' : ''}.`
    );

    const { simbolos, posicoes, slots } = await descobrirSimbolos({
      inicio: inicioBusca, fim, ignorar
    });
    rel.simbolos = simbolos.length;

    const posPorSymbol = new Map(posicoes.map((p) => [p.symbol, p]));
    const slotPorSymbol = new Map(slots.map((s) => [s.symbol, s]));

    if (simbolos.length === 0) {
      console.log('[SYNC-HIST] Nenhum símbolo com movimento, posição ou registro local na janela.');
      rel.duracaoMs = Date.now() - t0;
      ultimaSincronizacaoMs = Date.now();
      return rel;
    }

    // Preço do BNB uma única vez: converte comissão paga em BNB.
    let precoBNB = 0;
    try {
      const t = await fut.tickerPreco('BNBUSDT');
      precoBNB = num(t && t.price);
    } catch (err) {
      console.warn(`[SYNC-HIST] Sem preço de BNB (${fut.detalheErro(err)}). Taxas em BNB não serão convertidas.`);
    }

    let houveEscrita = false;

    for (const symbol of simbolos) {
      try {
        const posicao = posPorSymbol.get(symbol) || null;
        const posFinal = posicao ? num(posicao.positionAmt) : 0;

        const fills = await fut.userTradesCompleto(symbol, { startTime: inicioBusca, endTime: fim });

        if (fills.length === 0) {
          // Sem execução na janela. Duas situações merecem atenção:
          const slot = slotPorSymbol.get(symbol);
          if (slot && posFinal === 0) {
            rel.alertas.push(
              `${symbol}: slot local aberto sem posição na corretora e sem fills na janela — ` +
              'o fechamento é anterior à janela lida.'
            );
            if (!dryRun && opts.removerFantasmas) {
              await dbApi.deleteActiveSlot(slot.id);
              rel.slotsRemovidos += 1;
              houveEscrita = true;
              console.warn(`[SYNC-HIST] ${symbol}: slot fantasma #${slot.id} removido (removerFantasmas).`);
            }
          } else if (!slot && posFinal !== 0) {
            rel.alertas.push(
              `${symbol}: posição aberta na corretora (${posFinal}) sem slot local e sem fills na ` +
              'janela — abertura anterior à janela lida.'
            );
          }
          await dormir(DELAY_SIMBOLO_MS);
          continue;
        }

        const ciclos = reconstruirCiclos(symbol, fills, posFinal, precoBNB);
        const fechados = ciclos.filter((c) => !c.aberto);
        const abertos = ciclos.filter((c) => c.aberto);

        // Mapa de ordens só quando há fechamento para classificar.
        let ordensPorId = new Map();
        if (fechados.length > 0) {
          try {
            const ordens = await fut.todasOrdens(symbol, { startTime: inicioBusca, endTime: fim });
            ordensPorId = new Map(ordens.map((o) => [String(o.orderId), o]));
          } catch (err) {
            rel.alertas.push(`${symbol}: allOrders falhou (${fut.detalheErro(err)}); motivo do fechamento inferido pelo PnL.`);
          }
        }

        let fechouAlgumNaJanela = false;

        // ------------------------------------------------------
        // CICLOS FECHADOS -> trade_history
        // ------------------------------------------------------
        for (const ciclo of fechados) {
          // Só escreve o que fechou DENTRO da janela pedida. O recuo extra
          // existe para achar entradas, não para reimportar ontem inteiro.
          // `inicioJanela` já embute o piso do marco zero.
          if (!ciclo.fim || ciclo.fim < inicioJanela) continue;
          rel.ciclosFechados += 1;
          fechouAlgumNaJanela = true;

          const escrito = await gravarCicloFechado({
            ciclo, symbol, ordensPorId, slot: slotPorSymbol.get(symbol),
            posicao, dryRun, rel
          });
          if (escrito) houveEscrita = true;
        }

        // ------------------------------------------------------
        // CICLO ABERTO -> active_slots
        // ------------------------------------------------------
        for (const ciclo of abertos) {
          rel.ciclosAbertos += 1;
          const escrito = await gravarCicloAberto({
            ciclo, symbol, posicao, slot: slotPorSymbol.get(symbol), dryRun, rel
          });
          if (escrito) houveEscrita = true;
        }

        // ------------------------------------------------------
        // SLOT ÓRFÃO: corretora zerada mas o banco ainda acha que a
        // posição existe. Com um ciclo fechado nesta rodada, o registro da
        // operação já foi para o histórico — o slot pode sair com prova.
        // Sem essa prova, só sai se removerFantasmas estiver ligado.
        // ------------------------------------------------------
        const slot = slotPorSymbol.get(symbol);
        if (slot && posFinal === 0 && abertos.length === 0) {
          if (fechouAlgumNaJanela || opts.removerFantasmas) {
            if (!dryRun) {
              await dbApi.deleteActiveSlot(slot.id);
              houveEscrita = true;
            }
            rel.slotsRemovidos += 1;
            console.log(
              `[SYNC-HIST] ${symbol}: slot #${slot.id} removido — posição fechada na corretora ` +
              `${fechouAlgumNaJanela ? '(fechamento arquivado nesta rodada)' : '(removerFantasmas)'}.`
            );
          } else {
            rel.alertas.push(`${symbol}: slot local sem posição na corretora e sem ciclo fechado na janela.`);
          }
        }
      } catch (errSym) {
        const detalhe = fut.detalheErro(errSym);
        rel.erros.push(`${symbol}: ${detalhe}`);
        console.error(`[SYNC-HIST] ${symbol}: falha na sincronização — ${detalhe}`);
      }

      await dormir(DELAY_SIMBOLO_MS);
    }

    rel.duracaoMs = Date.now() - t0;
    ultimaSincronizacaoMs = Date.now();

    console.log(
      `[SYNC-HIST] Fim (${origem}) em ${rel.duracaoMs}ms — ${rel.simbolos} símbolo(s), ` +
      `${rel.ciclosFechados} ciclo(s) fechado(s) [${rel.inseridos} novo(s), ${rel.adotados} adotado(s), ` +
      `${rel.atualizados} atualizado(s)], ${rel.ciclosAbertos} aberto(s) ` +
      `[+${rel.slotsInseridos} / ~${rel.slotsAtualizados} / -${rel.slotsRemovidos}]` +
      `${rel.erros.length ? `, ${rel.erros.length} erro(s)` : ''}` +
      `${rel.alertas.length ? `, ${rel.alertas.length} alerta(s)` : ''}.`
    );
    for (const a of rel.alertas) console.warn(`[SYNC-HIST] ⚠ ${a}`);

    if (houveEscrita && typeof opts.onMudanca === 'function') {
      try {
        await opts.onMudanca(rel);
      } catch (errCb) {
        console.error(`[SYNC-HIST] Callback onMudanca falhou: ${errCb.message}`);
      }
    }

    return rel;
  } catch (err) {
    rel.ok = false;
    rel.duracaoMs = Date.now() - t0;
    rel.erros.push(fut.detalheErro(err));
    console.error(`[SYNC-HIST] Rodada (${origem}) abortada: ${fut.detalheErro(err)}`);
    return rel;
  } finally {
    emAndamento = false;
  }
}

// ============================================================
// ESCRITA — CICLO FECHADO
// ------------------------------------------------------------
// IDEMPOTÊNCIA EM TRÊS NÍVEIS, do mais forte ao mais fraco:
//   1. ciclo_id       — a linha já veio desta sincronização: UPDATE.
//   2. orderId da saída — a linha foi gravada pelo próprio motor: ADOTA
//      (carimba o ciclo_id e corrige os números com a execução real).
//   3. janela de tempo — linha legada, sem orderId: adota pelo par
//      símbolo + horário de saída dentro de ±5 min.
// Nada casou -> INSERT. O índice único parcial em ciclo_id é a rede final
// contra duas rodadas concorrentes inserindo o mesmo ciclo.
// ============================================================
async function gravarCicloFechado({ ciclo, symbol, ordensPorId, slot, posicao, dryRun, rel }) {
  const qty = ciclo.qtySaida;
  if (!(qty > 0)) return false;

  const precoSaida = ciclo.quoteSaida / qty;
  const precoEntrada = precoEntradaDe(ciclo);
  const taxas = ciclo.feeEntrada + ciclo.feeSaida;
  // PnL LÍQUIDO: realizado da corretora menos as comissões dos fills.
  // FUNDING_FEE fica de fora de propósito — é custo de carregar posição,
  // lançado na conta e não no trade; embuti-lo aqui faria o mesmo dinheiro
  // aparecer duas vezes na apuração do dia.
  const pnlUSDT = ciclo.pnlBruto - taxas;

  const registroLocal = slot || null;
  const alav = alavancagemDe(posicao, registroLocal);
  const notionalEntrada = precoEntrada * qty;
  const margem = alav > 0 ? notionalEntrada / alav : notionalEntrada;
  // ROI SOBRE A MARGEM (a régua dos alvos de 8%), não variação de preço.
  const pnlPercent = margem > 0 ? (pnlUSDT / margem) * 100 : 0;

  const sellOrderIds = [...ciclo.saidaOrderIds];
  const buyOrderIds = [...ciclo.entradaOrderIds];
  const ordemSaida = sellOrderIds
    .map((id) => ordensPorId.get(id))
    .filter(Boolean)
    .sort((a, b) => Number(b.updateTime || 0) - Number(a.updateTime || 0))[0] || null;
  const closeReason = classificarSaida(ordemSaida, pnlUSDT);

  // ciclo_id ancorado no PRIMEIRO FILL DE SAÍDA. Escolha deliberada: as
  // saídas são os eventos MAIS RECENTES do ciclo, então permanecem dentro
  // da janela por mais tempo que as entradas. Ancorar na entrada faria a
  // chave mudar quando a entrada saísse da janela — e chave que muda é
  // registro duplicado.
  const cicloId = `${symbol}:X${ciclo.primeiroFillSaida}`;

  const buyTime = ciclo.inicio || (slot ? num(slot.buy_time) : ciclo.fim);
  const registro = {
    symbol,
    buyPrice: precoEntrada,
    sellPrice: precoSaida,
    quantity: qty,
    investedUSDT: margem,
    pnlUSDT,
    pnlPercent,
    buyTime,
    sellTime: ciclo.fim,
    closeReason,
    direcao: ciclo.direcao,
    status: dbApi.statusPorPnl(pnlUSDT),
    cicloId,
    buyOrderId: buyOrderIds.join(','),
    sellOrderId: sellOrderIds.join(',')
  };

  const rotulo =
    `${symbol} ${ciclo.direcao} qty=${qty} ${precoEntrada.toFixed(8)} -> ${precoSaida.toFixed(8)} ` +
    `PnL=${pnlUSDT.toFixed(4)} USDT (${pnlPercent.toFixed(2)}% ROI, taxas ${taxas.toFixed(4)}) ` +
    `[${closeReason}] ${cicloId}${ciclo.herdado ? ' (entrada derivada do PnL)' : ''}` +
    `${ciclo.suspeito ? ' (NÃO CONFERIDO)' : ''}`;

  // Reconstrução que não fechou com a posição real não vira escrita: um
  // número errado no histórico contamina PnL do dia, placar e meta.
  if (ciclo.suspeito) {
    rel.alertas.push(`${symbol}: ciclo ${cicloId} não conferido contra a posição real — não gravado.`);
    return false;
  }

  // --- 1) já importado?
  const porCiclo = await dbApi.getTradeHistoryByCicloId(cicloId);
  if (porCiclo) {
    const mudou =
      Math.abs(num(porCiclo.pnl_usdt) - pnlUSDT) > 1e-8 ||
      Math.abs(num(porCiclo.sell_price) - precoSaida) > 1e-12 ||
      Math.abs(num(porCiclo.buy_price) - precoEntrada) > 1e-12 ||
      porCiclo.direcao !== ciclo.direcao ||
      porCiclo.status !== registro.status;
    if (!mudou) return false;                    // idempotente: nada a fazer
    if (!dryRun) {
      // close_reason vazio -> preserva o motivo que o motor local gravou
      // ('Trailing Stop', 'Radar Reverso'): ele sabe mais que a inferência
      // por tipo de ordem. Só carimba quando a linha nasceu da sincronização.
      await dbApi.updateTradeHistorySync(porCiclo.id, {
        ...registro,
        closeReason: String(porCiclo.close_reason || '').startsWith('SYNC_') ||
                     porCiclo.close_reason === closeReason ? closeReason : ''
      });
    }
    rel.atualizados += 1;
    console.log(`[SYNC-HIST] ~ atualizado #${porCiclo.id}: ${rotulo}`);
    return !dryRun;
  }

  // --- 2/3) linha do próprio motor: adotar em vez de duplicar.
  const candidatos = await dbApi.getTradeHistoryCandidatos(
    symbol, ciclo.fim - MATCH_JANELA_MS, ciclo.fim + MATCH_JANELA_MS
  );

  const setSaida = new Set(sellOrderIds);
  const setEntrada = new Set(buyOrderIds);
  const porOrderId = candidatos.find((c) => {
    const ids = String(c.sell_order_id || '').split(',').filter(Boolean);
    const idsEntrada = String(c.buy_order_id || '').split(',').filter(Boolean);
    return ids.some((id) => setSaida.has(id)) || idsEntrada.some((id) => setEntrada.has(id));
  });

  const alvo = porOrderId || candidatos.find(
    (c) => !c.ciclo_id && Math.abs(num(c.buy_time) - buyTime) <= MATCH_JANELA_MS
  );

  if (alvo) {
    if (!dryRun) {
      // Motivo local preservado: só é substituído se a linha já era da
      // sincronização ou se veio vazia.
      const manterMotivo = alvo.close_reason && !String(alvo.close_reason).startsWith('SYNC_');
      await dbApi.updateTradeHistorySync(alvo.id, {
        ...registro,
        closeReason: manterMotivo ? '' : closeReason
      });
    }
    rel.adotados += 1;
    console.log(
      `[SYNC-HIST] = adotado #${alvo.id} (${porOrderId ? 'orderId' : 'janela de tempo'}): ${rotulo}`
    );
    return !dryRun;
  }

  // --- INSERT
  if (!dryRun) {
    try {
      await dbApi.insertTradeHistory({ ...registro, dossieTexto: '', execTipo: 'SYNC', execDetalhe: rotulo });
    } catch (err) {
      // Corrida com outra rodada: o índice único de ciclo_id barrou. Não é
      // falha — é exatamente a proteção fazendo o trabalho dela.
      if (/UNIQUE constraint failed/i.test(err.message)) {
        console.log(`[SYNC-HIST] ${cicloId} já inserido por outra rodada (índice único). Ignorado.`);
        return false;
      }
      throw err;
    }
  }
  rel.inseridos += 1;
  console.log(`[SYNC-HIST] + inserido: ${rotulo}`);
  return !dryRun;
}

// ============================================================
// ESCRITA — CICLO ABERTO
// ------------------------------------------------------------
// A posição existe na corretora AGORA. O banco tem que refletir isso, com
// a direção certa, mesmo que o slot tenha nascido em outra instância do
// processo (ou não exista, no caso da entrada que o restart perdeu).
//
// Quantidade e preço de entrada vêm da POSIÇÃO, não dos fills: entryPrice
// da corretora já é a média ponderada de tudo que compõe a posição viva,
// inclusive o que ficou fora da janela lida.
// ============================================================
async function gravarCicloAberto({ ciclo, symbol, posicao, slot, dryRun, rel }) {
  const qty = posicao ? Math.abs(num(posicao.positionAmt)) : ciclo.qtyRestante;
  if (!(qty > 0)) return false;

  const direcao = posicao ? posicao.lado : ciclo.direcao;
  const precoEntrada = posicao && num(posicao.precoEntrada) > 0
    ? num(posicao.precoEntrada)
    : precoEntradaDe(ciclo);
  if (!(precoEntrada > 0)) {
    rel.alertas.push(`${symbol}: posição aberta sem preço de entrada apurável — slot não escrito.`);
    return false;
  }

  const alav = alavancagemDe(posicao, slot);
  const margem = (precoEntrada * qty) / (alav > 0 ? alav : 1);
  const buyTime = ciclo.inicio || (slot ? num(slot.buy_time) : Date.now());
  const cicloId = ciclo.primeiroFillEntrada != null
    ? `${symbol}:E${ciclo.primeiroFillEntrada}`
    : (slot && slot.ciclo_id) || `${symbol}:ABERTA`;
  const buyOrderId = [...ciclo.entradaOrderIds].join(',');

  const rotulo =
    `${symbol} ${direcao} qty=${qty} entrada=${precoEntrada.toFixed(8)} ` +
    `margem=${margem.toFixed(4)} USDT (${alav}x) ${cicloId}`;

  if (slot) {
    const mudou =
      Math.abs(num(slot.quantity) - qty) > 1e-12 ||
      Math.abs(num(slot.buy_price) - precoEntrada) > 1e-12 ||
      Math.abs(num(slot.invested_usdt) - margem) > 1e-8 ||
      (slot.direcao || 'LONG') !== direcao ||
      slot.ciclo_id !== cicloId;
    if (!mudou) return false;
    if (!dryRun) {
      await dbApi.updateActiveSlotSync(slot.id, {
        buyPrice: precoEntrada,
        quantity: qty,
        investedUSDT: margem,
        // buy_time do registro local prevalece: é o instante em que a
        // ESTRATÉGIA entrou. Sobrescrever com o fill mais antigo da janela
        // deslocaria a idade da posição usada pelas regras de saída.
        buyTime: slot.buy_time ? num(slot.buy_time) : buyTime,
        direcao,
        cicloId,
        buyOrderId: buyOrderId || slot.buy_order_id || ''
      });
    }
    rel.slotsAtualizados += 1;
    console.log(`[SYNC-HIST] ~ slot #${slot.id} realinhado: ${rotulo}`);
    return !dryRun;
  }

  // Posição viva SEM slot local: o caso clássico do restart no meio da
  // entrada. Sem esta linha, o motor não monitora a posição — ela fica
  // órfã, sem stop local e fora de todo relatório.
  if (!dryRun) {
    try {
      await dbApi.insertActiveSlot({
        symbol,
        buyPrice: precoEntrada,
        quantity: qty,
        investedUSDT: margem,
        buyTime,
        stopPrice: 0,           // motor recalcula; 0 = ainda sem SL estrutural
        dossieTexto: 'Slot reconstruído do histórico de Futuros da Binance (sincronização).',
        execTipo: 'SYNC',
        execDetalhe: rotulo,
        buyOrderId,
        direcao,
        cicloId
      });
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(err.message)) {
        console.log(`[SYNC-HIST] ${symbol}: slot criado por outra rodada (índice único). Ignorado.`);
        return false;
      }
      throw err;
    }
  }
  rel.slotsInseridos += 1;
  console.log(`[SYNC-HIST] + slot reconstruído: ${rotulo}`);
  return !dryRun;
}

// ============================================================
// AGENDAMENTO. Boot + tick periódico. O boot é o momento mais importante:
// é onde o processo descobre tudo que aconteceu enquanto esteve fora do ar.
// ============================================================
function agendarSincronizacaoHistorico(opts = {}) {
  const intervaloMs = Number(opts.intervaloMs) > 0
    ? Number(opts.intervaloMs)
    : 15 * 60 * 1000;

  const rodar = (origem) =>
    sincronizarHistoricoFuturos({ ...opts, origem }).catch((err) =>
      console.error(`[SYNC-HIST] Falha não tratada (${origem}): ${err.message}`)
    );

  const timer = setInterval(() => rodar(`tick ${Math.round(intervaloMs / 60000)}min`), intervaloMs);
  if (typeof timer.unref === 'function' && opts.unref) timer.unref();
  console.log(
    `[SYNC-HIST] Sincronização pelo histórico agendada a cada ${Math.round(intervaloMs / 60000)} min.`
  );
  return { timer, rodar };
}

module.exports = {
  sincronizarHistoricoFuturos,
  agendarSincronizacaoHistorico,
  // exportados para teste/inspeção
  reconstruirCiclos,
  precoEntradaDe,
  classificarSaida,
  alavancagemDe,
  ultimaSincronizacao: () => ultimaSincronizacaoMs,
  JANELA_PADRAO_MS
};
