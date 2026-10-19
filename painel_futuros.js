const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fut = require('./lib/futuresApi');
const ti = require('technicalindicators');
const axios = require('axios');
const fs = require('fs');
const db = require('./db');
const rag = require('./lib/rag_memory');

const routerApiKey = process.env.ROUTER_API_KEY || '';

let usdtBrl = 5.0;
let marcoZeroFile = path.join(__dirname, '.marco_zero_painel');
let marcoZero = fs.existsSync(marcoZeroFile) ? parseInt(fs.readFileSync(marcoZeroFile, 'utf8')) : new Date().setHours(0,0,0,0);

async function atualizarBRL() {
  try {
    const r = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL');
    if (r.data && r.data.price) usdtBrl = parseFloat(r.data.price);
  } catch(e) {}
}
setInterval(atualizarBRL, 60000);
atualizarBRL();

const alvosFile = path.join(__dirname, 'alvos_painel.json');
let localAlvos = fs.existsSync(alvosFile) ? JSON.parse(fs.readFileSync(alvosFile, 'utf8')) : {};
function salvarAlvos() { fs.writeFileSync(alvosFile, JSON.stringify(localAlvos)); }

const metaTradesFile = path.join(__dirname, '.trades_metadata.json');
let tradesMetadata = fs.existsSync(metaTradesFile) ? JSON.parse(fs.readFileSync(metaTradesFile, 'utf8')) : {};
function registrarMetaTrade(symbol, side, alavancagem) {
  tradesMetadata[symbol] = {
    side: side === 'BUY' ? 'LONG' : (side === 'SELL' ? 'SHORT' : side),
    leverage: alavancagem,
    time: Date.now()
  };
  try { fs.writeFileSync(metaTradesFile, JSON.stringify(tradesMetadata)); } catch(e) {}
}

const tokensFile = path.join(__dirname, '.tokens_usage.json');
let tokensGastos = fs.existsSync(tokensFile) ? JSON.parse(fs.readFileSync(tokensFile, 'utf8')) : { prompt: 0, completion: 0, total: 0 };
function registrarUsoTokens(usage) {
  if (!usage) return;
  tokensGastos.prompt = (tokensGastos.prompt || 0) + (usage.prompt_tokens || 0);
  tokensGastos.completion = (tokensGastos.completion || 0) + (usage.completion_tokens || 0);
  tokensGastos.total = (tokensGastos.total || 0) + (usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)));
  try { fs.writeFileSync(tokensFile, JSON.stringify(tokensGastos)); } catch(e) {}
}

const maxRoiTracker = {};

// Loop de monitoramento de alvos (Soft TP/SL inteligente com Trailing de Lucro)
setInterval(async () => {
  for (const sym of Object.keys(localAlvos)) {
    try {
      const alvo = localAlvos[sym];
      const pos = await fut.posicao(sym);
      if (!pos || pos.quantidade === 0) {
        delete localAlvos[sym];
        delete maxRoiTracker[sym];
        salvarAlvos();
        continue; // já fechou ou não existe
      }
      
      const margem = pos.margem || ((pos.quantidade * pos.precoEntrada) / (pos.alavancagem || 1));
      let roi = 0;
      if (margem > 0) roi = (pos.pnlNaoRealizado / margem) * 100;

      if (!maxRoiTracker[sym]) maxRoiTracker[sym] = roi;
      else if (roi > maxRoiTracker[sym]) maxRoiTracker[sym] = roi;
      const peakRoi = maxRoiTracker[sym];
      
      // 1. Take Profit Fixo (padrão 8%)
      const targetTp = alvo.tp || 8;
      // 2. Stop Loss Fixo (padrão 10%)
      const targetSl = alvo.sl || 10;

      let deveFechar = false;
      let motivoFechamento = '';

      if (roi >= targetTp) {
        deveFechar = true;
        motivoFechamento = `[SOFT TP] Atingiu ${roi.toFixed(2)}% >= ${targetTp}%`;
      } else if (roi <= -targetSl) {
        deveFechar = true;
        motivoFechamento = `[SOFT SL] Atingiu ${roi.toFixed(2)}% <= -${targetSl}%`;
      } else if (peakRoi >= 4.0 && (peakRoi - roi) >= 1.0) {
        // Trailing Dinâmico: só ativa após o lucro atingir pelo menos 4%. Se recuar 1% do topo, garante o lucro
        deveFechar = true;
        motivoFechamento = `[TRAILING 1%] Pico foi ${peakRoi.toFixed(2)}% (>=4%) e recuou 1% para ${roi.toFixed(2)}%`;
      } else if (peakRoi >= 2.5 && roi <= 0.4) {
        // Breakeven 0 a 0: Atingiu pelo menos +2.5% de ROI. Se recuar para +0.4% (taxas Binance pagas), fecha sem prejuízo!
        deveFechar = true;
        motivoFechamento = `[BREAKEVEN 0.4%] Pico foi ${peakRoi.toFixed(2)}% (>=2.5%) e recuou para ${roi.toFixed(2)}% (0 a 0 com taxas pagas)`;
      }

      if (deveFechar) {
         console.log(`[FECHAMENTO ALVO] ${sym}: ${motivoFechamento}`);
         await fut.cancelarTodasOrdens(sym);
         await fut.fecharMercado(sym, pos.lado, pos.quantidade);

         const exitTipo = motivoFechamento.includes('TP') ? 'TP' : (motivoFechamento.includes('BREAKEVEN') ? 'BREAKEVEN' : (motivoFechamento.includes('SL') ? 'SL' : 'TRAILING'));
         await rag.salvarSaidaRAG({
           symbol: sym,
           exitPrice: pos.precoEntrada ? (pos.precoEntrada * (1 + (roi / 100 / (pos.alavancagem || 1)))) : 0,
           exitReason: exitTipo,
           roiPct: roi,
           pnlUsdt: pos.pnlNaoRealizado
         }).catch(() => {});

         // Libera o slot com cooldown de 45s pós-saída para respirada
         [1, 2].forEach(s => {
           if (autoBotState.slots[s].symbol === sym) {
             autoBotState.slots[s].symbol = null;
             autoBotState.slots[s].side = null;
             autoBotState.slots[s].targetSymbol = null;
             autoBotState.slots[s].plano = null;
             autoBotState.slots[s].searchCooldownUntil = Date.now() + 45000;
             autoBotState.slots[s].status = 'FECHADO_COOLDOWN_45S';
           }
         });

         delete localAlvos[sym];
         delete maxRoiTracker[sym];
         salvarAlvos();
      }
    } catch(e) {
      // ignora erro de rede temporario
    }
  }
}, 3000); // 3 segundos

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = 7005;
const SENHA = process.env.ACESSO_SENHA || 'admin123';

app.use((req, res, next) => {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (password === SENHA || login === SENHA) return next();
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Acesso Negado');
});

const getCandleColor = async (symbol, interval) => {
  try {
    const k = await fut.klines(symbol, interval, 1);
    if (!k || k.length === 0) return 'gray';
    const vela = k[k.length - 1];
    const open = parseFloat(vela[1]);
    const close = parseFloat(vela[4]);
    return close >= open ? 'green' : 'red';
  } catch (err) {
    return 'gray';
  }
};

app.get('/api/volateis', async (req, res) => {
  try {
    const data = await fut.ticker24h();
    if (!Array.isArray(data)) throw new Error('Não foi possível ler tickers');
    const filtered = data
      .filter(t => t.symbol.endsWith('USDT'))
      .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
      .slice(0, 10)
      .map(t => ({
        symbol: t.symbol,
        pct: parseFloat(t.priceChangePercent).toFixed(2),
        price: parseFloat(t.lastPrice).toFixed(4)
      }));
    res.json({ success: true, top: filtered });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/limpar-historico', (req, res) => {
  marcoZero = Date.now();
  fs.writeFileSync(marcoZeroFile, marcoZero.toString());
  res.json({ success: true });
});

app.get('/api/saldo', async (req, res) => {
  try {
    const s = await fut.saldoUSDT();
    // Fetch both PNL and FEES to calculate true net PNL for the day
    const h = await fut.income({ startTime: marcoZero, limit: 1000 });
    let pnlHoje = 0;
    for (const item of h || []) {
      if (item.symbol !== 'HEMIUSDT' && item.time >= marcoZero) {
        if (item.incomeType === 'REALIZED_PNL' || item.incomeType === 'COMMISSION' || item.incomeType === 'FUNDING_FEE') {
          pnlHoje += parseFloat(item.income);
        }
      }
    }
    res.json({ success: true, saldo: s.total, disponivel: s.disponivel, pnlHoje, brl: usdtBrl });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/gauge/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const book = await fut.livroOfertas(symbol, 20);
    let bidQty = 0, askQty = 0;
    (book.bids || []).forEach(b => bidQty += parseFloat(b[1]));
    (book.asks || []).forEach(a => askQty += parseFloat(a[1]));
    const total = bidQty + askQty;
    let baseLong = 50;
    if (total > 0) baseLong = (bidQty / total) * 100;

    let fundingRate = 0;
    let oi = 0;
    try {
      const [fRes, oRes] = await Promise.all([
        axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
        axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`)
      ]);
      fundingRate = parseFloat(fRes.data.lastFundingRate) || 0;
      oi = parseFloat(oRes.data.openInterest) || 0;
    } catch(e) {}

    // Ajuste da % do botão:
    // Funding Rate padrão é 0.01%. 
    // Se o funding for alto (mercado lotado de longs pagando shorts), o risco de squeeze de short é alto -> tira % do Long.
    // Peso: cada 0.01% acima do padrão tira 5% da recomendação de Long.
    const fundingShift = -((fundingRate - 0.0001) * 50000); 
    
    let finalLongPct = Math.round(baseLong + fundingShift);
    if (finalLongPct > 95) finalLongPct = 95;
    if (finalLongPct < 5) finalLongPct = 5;

    res.json({ 
      success: true, 
      longPct: finalLongPct, 
      shortPct: 100 - finalLongPct,
      fundingRate,
      openInterest: oi,
      bidAskBase: Math.round(baseLong)
    });
  } catch (e) {
    res.json({ success: false });
  }
});

app.get('/api/historico-completo', async (req, res) => {
  try {
    const h = await fut.income({ startTime: marcoZero, limit: 1000 });
    const clean = [];
    let totPnl = 0, totFee = 0;
    for (const item of h || []) {
      if (item.symbol === 'HEMIUSDT' || item.time < marcoZero) continue;
      const val = parseFloat(item.income);
      if (item.incomeType === 'REALIZED_PNL') totPnl += val;
      if (item.incomeType === 'COMMISSION' || item.incomeType === 'FUNDING_FEE') totFee += val;
      
      clean.push({
        time: item.time,
        symbol: item.symbol || '--',
        type: item.incomeType,
        val: val
      });
    }
    // Sort desc by time
    clean.sort((a,b) => b.time - a.time);
    
    res.json({ success: true, trades: clean, totPnl, totFee, brl: usdtBrl, metadata: tradesMetadata });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/historico', async (req, res) => {
  try {
    // Busca PNL. Testnet da Binance costuma injetar lixo (ex: HEMIUSDT).
    // Para limpar a tela, vamos ignorar operações antigas (antes de hoje) e HEMIUSDT.
    const startTime = new Date().setHours(0,0,0,0);
    const h = await fut.income({ incomeType: 'REALIZED_PNL', startTime, limit: 300 });
    
    const byDay = {};
    for (const item of h || []) {
      if (item.symbol === 'HEMIUSDT') continue; // Lixo da testnet
      const dataStr = new Date(item.time).toISOString().split('T')[0];
      if (!byDay[dataStr]) byDay[dataStr] = { total: 0, trades: [] };
      const val = parseFloat(item.income);
      byDay[dataStr].total += val;
      byDay[dataStr].trades.push({ symbol: item.symbol, income: val, time: item.time });
    }
    res.json({ success: true, byDay });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/ia-analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const pos = await fut.posicao(symbol);
    if (!pos || pos.quantidade === 0 || pos.pnlNaoRealizado <= 0) {
       return res.json({ success: true, recomendacao: 'MANTER' });
    }
    
    const velas = await fut.klines(symbol, '15m', 20);
    if (!velas || velas.length === 0) return res.json({ success: true, recomendacao: 'MANTER' });
    
    const closes = velas.map(v => parseFloat(v[4])).join(', ');
    const prompt = `Você é um bot de análise técnica avançado atuando como conselheiro.
Estou em uma posição ${pos.lado} na moeda ${symbol} alavancado em ${pos.alavancagem}x.
Preço de entrada: ${pos.precoEntrada}.
Preço atual (aprox): ${velas[velas.length-1][4]}.
Lucro atual: ${pos.pnlNaoRealizado} USDT.
Últimos 20 fechamentos de 15m: ${closes}

Dado o padrão atual de preços e sabendo que o objetivo é não devolver o lucro para o mercado, faça uma verificação profunda.
Você deve responder APENAS com a palavra SAIR (se a tendência mostra fraqueza ou risco de reversão) ou MANTER (se o movimento continua forte a meu favor).`;

    const r = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: "ag/gemini-3.8-flash-high", 
      messages: [{ role: "user", content: prompt }],
      max_tokens: 250,
      temperature: 0.2,
      stream: false
    }, { headers: { "Authorization": `Bearer ${routerApiKey}` }, timeout: 25000 });
    
    const text = r.data?.choices?.[0]?.message?.content?.toUpperCase() || '';
    if (text.includes('SAIR')) {
      res.json({ success: true, recomendacao: 'SAIR' });
    } else {
      res.json({ success: true, recomendacao: 'MANTER' });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/ia-advise/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const velas1m = await fut.klines(symbol, '1m', 15);
    if (!velas1m || velas1m.length < 10) return res.json({ success: false });
    
    const closes = velas1m.map(v => parseFloat(v[4])).join(', ');
    const prompt = `Atue como conselheiro amigável de mercado de FUTUROS (onde se lucra na alta ou na queda). Fechamentos 1m do ${symbol}: ${closes}. 
Forneça uma dica extremamente simples, curta e direta (MÁXIMO DE 15 PALAVRAS). Não use jargões. Diga a tendência atual e recomende: COMPRAR (apostar na alta), VENDER (apostar na queda) ou AGUARDAR (se perigoso/incerto).`;

    const r = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: "ag/gemini-3.8-flash-high",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 250,
      temperature: 0.4,
      stream: false
    }, { headers: { "Authorization": `Bearer ${routerApiKey}` }, timeout: 25000 });
    
    let text = r.data?.choices?.[0]?.message?.content || 'Aguardando padrão claro...';
    text = text.replace(/[\r\n]+/g, ' ').trim();
    res.json({ success: true, advice: text });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/moeda/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const intervals = ['1d', '12h', '6h', '3h', '1h', '15m', '1m'];
  try {
    const results = {};
    let greens = 0;
    for (const int of intervals) {
      const color = await getCandleColor(symbol, int);
      results[int] = color;
      if (color === 'green') greens++;
    }
    const score = Math.round((greens / intervals.length) * 100);
    const precoData = await fut.tickerPreco(symbol);
    const preco = precoData && precoData.price ? precoData.price : '???';
    const pos = await fut.posicao(symbol);
    
    // ANÁLISE TÉCNICA (IA/Code) - Últimas 20 velas de 15m
    let trend = 'NEUTRA';
    let trendColor = 'gray';
    let rsiVal = '--';
    
    try {
       const velas = await fut.klines(symbol, '15m', 20);
       if (velas && velas.length >= 14) {
          const opens = velas.map(v => parseFloat(v[1]));
          const highs = velas.map(v => parseFloat(v[2]));
          const lows = velas.map(v => parseFloat(v[3]));
          const closes = velas.map(v => parseFloat(v[4]));
          
          const rsiArr = ti.RSI.calculate({ period: 14, values: closes });
          if (rsiArr.length) {
             const lastRsi = rsiArr[rsiArr.length - 1];
             rsiVal = lastRsi.toFixed(1);
             if (lastRsi > 70) { trend = 'SOBRECOMPRADA (Risco Queda)'; trendColor = 'var(--red)'; }
             else if (lastRsi < 30) { trend = 'SOBREVENDIDA (Oportunidade)'; trendColor = 'var(--green)'; }
             else if (lastRsi > 55) { trend = 'FORÇA DE COMPRA'; trendColor = 'var(--green)'; }
             else if (lastRsi < 45) { trend = 'FORÇA DE VENDA'; trendColor = 'var(--red)'; }
          }
          
          const bullE = ti.bullishengulfingpattern({ open: opens, high: highs, low: lows, close: closes });
          const bearE = ti.bearishengulfingpattern({ open: opens, high: highs, low: lows, close: closes });
          
          if (bullE.length && bullE[bullE.length - 1]) { trend = 'REVERSÃO ALTA (Engulfing)'; trendColor = 'var(--green)'; }
          if (bearE.length && bearE[bearE.length - 1]) { trend = 'REVERSÃO BAIXA (Engulfing)'; trendColor = 'var(--red)'; }
       }
    } catch(e) {}
    
    res.json({ success: true, symbol, intervals: results, score, preco, pos, trend, trendColor, rsi: rsiVal });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/trade', async (req, res) => {
  try {
    const { symbol, lado, valorUSDT, alavancagem } = req.body;
    const alav = parseInt(alavancagem) || 1;
    registrarMetaTrade(symbol, lado, alav);
    await fut.garantirAlavancagem(symbol, alav, 'ISOLATED');
    
    const book1 = await fut.livroOfertas(symbol, 5);
    const preco1 = parseFloat(lado === 'BUY' ? (book1.asks[0] || [])[0] : (book1.bids[0] || [])[0]);
    if (!preco1) throw new Error('Livro vazio');
    const calc1 = fut.calcularQuantidade(symbol, parseFloat(valorUSDT), preco1, alav);
    if (!calc1.ok) throw new Error(calc1.motivo);
    
    let ord1 = await fut.colocarLimite(symbol, lado, calc1.qty, preco1);
    await new Promise(r => setTimeout(r, 1200));
    try { await fut.cancelarOrdem(symbol, ord1.orderId); } catch(e){}
    let st1 = await fut.consultarOrdem(symbol, ord1.orderId);
    let fill1 = parseFloat(st1.executedQty) || 0;
    // Função auxiliar para armar Stop-Loss
    const armarStop = async () => {
      try {
         const pos = await fut.posicao(symbol);
         if (pos && pos.quantidade > 0) {
           const pEntrada = pos.precoEntrada;
           const pctSL = 0.10 / alav; // 10% de ROI
           const pStop = pos.lado === 'LONG' ? pEntrada * (1 - pctSL) : pEntrada * (1 + pctSL);
           await fut.colocarStopLoss(symbol, pos.lado, pStop);
         }
      } catch(e) { console.error('Erro SL:', e.message); }
    };

    if (st1.status === 'FILLED' || fill1 >= calc1.qty) {
       await armarStop();
       return res.json({ success: true, result: st1 });
    }
    
    let qtyFalta = calc1.qty - fill1;
    if (qtyFalta * preco1 < 6) {
       await armarStop();
       return res.json({ success: false, error: 'Preencheu parcial e resto < $6.' });
    }
    
    const book2 = await fut.livroOfertas(symbol, 5);
    const preco2 = parseFloat(lado === 'BUY' ? (book2.asks[0] || [])[0] : (book2.bids[0] || [])[0]);
    if (Math.abs(preco2 - preco1) / preco1 > 0.003) {
       await armarStop();
       return res.json({ success: false, error: 'Derrapou (>0.3%) e não entrou.' });
    }
    
    let ord2 = await fut.colocarLimite(symbol, lado, qtyFalta, preco2);
    await new Promise(r => setTimeout(r, 1200));
    try { await fut.cancelarOrdem(symbol, ord2.orderId); } catch(e){}
    let st2 = await fut.consultarOrdem(symbol, ord2.orderId);
    let fill2 = parseFloat(st2.executedQty) || 0;
    
    await armarStop();
    
    if (fill1 + fill2 === 0) {
      return res.json({ success: false, error: 'A ordem escorregou e o limite não pegou (0 executado).' });
    } else if (fill1 + fill2 < calc1.qty) {
      return res.json({ success: true, warning: 'Preenchimento parcial: ' + (fill1 + fill2) + ' / ' + calc1.qty, result: st2 });
    }
    res.json({ success: true, result: st2 });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.post('/api/close', async (req, res) => {
  try {
    const { symbol } = req.body;
    const pos = await fut.posicao(symbol);
    if (!pos) throw new Error('Nenhuma posicao aberta.');
    const r = await fut.fecharMercado(symbol, pos.lado, pos.quantidade);
    res.json({ success: true, result: r });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.post('/api/tp-sl', async (req, res) => {
  try {
    const { symbol, tpPct, slPct } = req.body;
    const pos = await fut.posicao(symbol);
    if (!pos || pos.quantidade === 0) throw new Error('Nenhuma posição aberta.');
    
    // Removemos ordens da corretora (se houver antigas)
    await fut.cancelarTodasOrdens(symbol);
    
    // Armazena no controle local (Soft TP/SL)
    localAlvos[symbol] = {
      tp: (tpPct && !isNaN(tpPct)) ? parseFloat(tpPct) : null,
      sl: (slPct && !isNaN(slPct)) ? parseFloat(slPct) : null
    };
    salvarAlvos();
    
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/reverse', async (req, res) => {
  try {
    const { symbol } = req.body;
    const pos = await fut.posicao(symbol);
    if (!pos) throw new Error('Nenhuma posicao para reverter.');
    
    const originalLado = pos.lado;
    const oppositeLado = originalLado === 'LONG' ? 'SELL' : 'BUY';
    const qty = pos.quantidade;
    const alav = pos.alavancagem || 1;
    
    await fut.cancelarTodasOrdens(symbol);
    await fut.fecharMercado(symbol, originalLado, qty);
    registrarMetaTrade(symbol, oppositeLado, alav);
    const novaOrdem = await fut.abrirMercado(symbol, oppositeLado, qty);
    
    // Armar novo Stop-Loss na nova posição
    const posNova = await fut.posicao(symbol);
    if (posNova && posNova.quantidade > 0) {
       const pctSL = 0.10 / alav;
       const pStop = posNova.lado === 'LONG' ? posNova.precoEntrada * (1 - pctSL) : posNova.precoEntrada * (1 + pctSL);
       await fut.colocarStopLoss(symbol, posNova.lado, pStop);
    }
    
    res.json({ success: true, result: novaOrdem });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// ==========================================
// MÓDULO AUTÔNOMO: CICLOS DE 10 MINUTOS + IA
// ==========================================
const autoBotConfigFile = path.join(__dirname, '.auto_bot_config.json');
const dobradinhaFile = path.join(__dirname, '.dobradinha_stats.json');

function carregarAutoBotConfig() {
  try {
    if (fs.existsSync(autoBotConfigFile)) return JSON.parse(fs.readFileSync(autoBotConfigFile, 'utf8'));
  } catch(e) {}
  return { enabled: false };
}
function salvarAutoBotConfig(enabled) {
  try { fs.writeFileSync(autoBotConfigFile, JSON.stringify({ enabled })); } catch(e) {}
}

function carregarDobradinha() {
  try {
    if (fs.existsSync(dobradinhaFile)) return JSON.parse(fs.readFileSync(dobradinhaFile, 'utf8'));
  } catch(e) {}
  return { winDobradinha: 0, lossDobradinha: 0 };
}
function salvarDobradinha(data) {
  try { fs.writeFileSync(dobradinhaFile, JSON.stringify(data)); } catch(e) {}
}

const savedBotConfig = carregarAutoBotConfig();

let autoBotState = {
  enabled: savedBotConfig.enabled === true,
  slots: {
    1: { targetSymbol: null, symbol: null, openTime: 0, searchTime: 0, lastCheckTime: 0, lastIaProfitCheck: 0, side: null, status: 'IDLE', score: 0, mode: 'TENDENCIA', details: '', leverage: 3, isSearching: false, plano: null },
    2: { targetSymbol: null, symbol: null, openTime: 0, searchTime: 0, lastCheckTime: 0, lastIaProfitCheck: 0, side: null, status: 'IDLE', score: 0, mode: 'TENDENCIA', details: '', leverage: 3, isSearching: false, plano: null }
  },
  lastLog: savedBotConfig.enabled ? 'Robô Contínuo Ativo' : 'Inativo'
};

// ============================================================
// GAMIFICAÇÃO DOS INDICADORES TÉCNICOS (0 TOKENS, RESPOSTA < 5ms)
// Avalia confluência e detecta armadilhas de Smart Money / Contrarian
// ============================================================
function calcularScoreGamificado(dados, sideDesejado = 'BUY', tesePlano = 'TENDENCIA') {
  if (!dados) return { score: 0, detalhes: 'Sem dados', modo: tesePlano, sideExecucao: sideDesejado, cautelaMultiplicacao: false };

  let score = 50;
  let detalhes = [];
  let modoDetectado = tesePlano || 'TENDENCIA';
  let sideExecucao = sideDesejado;
  let cautelaMultiplicacao = false;

  // 1. Médias Rápidas EMA 9 vs 21 (1m) - ±20 pts
  if (sideDesejado === 'BUY') {
    if (dados.emaStatus && dados.emaStatus.startsWith('ALTA')) { score += 20; detalhes.push('EMA9>EMA21 (+20)'); }
    else { score -= 20; detalhes.push('EMA9<EMA21 (-20)'); }
  } else {
    if (dados.emaStatus && dados.emaStatus.startsWith('BAIXA')) { score += 20; detalhes.push('EMA9<EMA21 (+20)'); }
    else { score -= 20; detalhes.push('EMA9>EMA21 (-20)'); }
  }

  // 2. Parabolic SAR (1m) - ±20 pts
  if (sideDesejado === 'BUY') {
    if (dados.sarTendencia && dados.sarTendencia.startsWith('ALTA')) { score += 20; detalhes.push('SAR Alta (+20)'); }
    else { score -= 20; detalhes.push('SAR Baixa (-20)'); }
  } else {
    if (dados.sarTendencia && dados.sarTendencia.startsWith('BAIXA')) { score += 20; detalhes.push('SAR Baixa (+20)'); }
    else { score -= 20; detalhes.push('SAR Alta (-20)'); }
  }

  // 3. Volume Ratio - até 20 pts
  const vr = parseFloat(dados.volRatio || 1);
  if (vr >= 1.5) { score += 20; detalhes.push(`VolForte ${vr}x (+20)`); }
  else if (vr >= 1.1) { score += 10; detalhes.push(`VolMédio ${vr}x (+10)`); }
  else if (vr < 0.7) { score -= 15; detalhes.push(`VolSeco ${vr}x (-15)`); }

  // 4. RSI (15m) - até 15 pts
  const rsiVal = parseFloat(dados.rsi || 50);
  if (sideDesejado === 'BUY') {
    if (rsiVal >= 45 && rsiVal <= 65) { score += 15; detalhes.push('RSI 15m Saudável (+15)'); }
    else if (rsiVal > 72) { score -= 25; detalhes.push('RSI Sobrecomprado (-25)'); }
  } else {
    if (rsiVal <= 55 && rsiVal >= 35) { score += 15; detalhes.push('RSI 15m Saudável (+15)'); }
    else if (rsiVal < 28) { score -= 25; detalhes.push('RSI Sobrevendido (-25)'); }
  }

  // 5. Livro de Ofertas - até 15 pts
  const longP = parseFloat(dados.longPct || 50);
  const shortP = parseFloat(dados.shortPct || 50);
  if (sideDesejado === 'BUY') {
    if (longP >= 55) { score += 15; detalhes.push(`Book Comprador ${longP}% (+15)`); }
    else if (shortP >= 60) { score -= 15; detalhes.push(`Book Vendedor ${shortP}% (-15)`); }
  } else {
    if (shortP >= 55) { score += 15; detalhes.push(`Book Vendedor ${shortP}% (+15)`); }
    else if (longP >= 60) { score -= 15; detalhes.push(`Book Comprador ${longP}% (-15)`); }
  }

  // 6. Padrões de Candlesticks
  const pads = dados.padroesDetectados || [];
  if (pads.includes('Doji (Indecisão)')) {
    score -= 20;
    detalhes.push('Doji (-20)');
  }
  if (sideDesejado === 'BUY') {
    if (pads.some(p => p.includes('Alta') || p.includes('Martelo') || p.includes('Engolfo de Alta'))) {
      score += 15; detalhes.push('Padrão Alta (+15)');
    }
  } else {
    if (pads.some(p => p.includes('Baixa') || p.includes('Estrela') || p.includes('Engolfo de Baixa'))) {
      score += 15; detalhes.push('Padrão Baixa (+15)');
    }
  }

  // 7. DETECÇÃO DE ARMADILHA (Contrarian / Smart Money)
  const fundRate = parseFloat(dados.fundingRate || 0);
  // Se varejo berrando COMPRA (score alto), mas funding caro e RSI alto -> Armadilha de Long
  if ((sideDesejado === 'BUY' && score >= 70 && fundRate > 0.0002) || tesePlano === 'ARMADILHA_CONTRARIA') {
    if (tesePlano === 'ARMADILHA_CONTRARIA' || (score >= 70 && fundRate > 0.0002)) {
      modoDetectado = 'ARMADILHA_CONTRARIA';
      sideExecucao = sideDesejado === 'BUY' ? 'SELL' : 'BUY';
      cautelaMultiplicacao = true;
      score = 80;
      detalhes.push('ARMADILHA DETECTADA! Invertendo com cautela de multiplicação');
    }
  } else if ((sideDesejado === 'SELL' && score >= 70 && fundRate < -0.0002)) {
    modoDetectado = 'ARMADILHA_CONTRARIA';
    sideExecucao = 'BUY';
    cautelaMultiplicacao = true;
    score = 80;
    detalhes.push('ARMADILHA VENDA DETECTADA! Invertendo com cautela de multiplicação');
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    detalhes: detalhes.join(' | '),
    modo: modoDetectado,
    sideExecucao,
    cautelaMultiplicacao
  };
}

// ============================================================
// IA ESTRATEGISTA: BUSCA INDEPENDENTE DE MOEDA PARA O SLOT
// Cada slot pesquisa individualmente assim que fica livre
// Anti-conflito: nunca escolhe a moeda que o outro slot já está operando
// ============================================================
let buscandoMoedaMutex = false;
async function buscarMelhorMoedaParaSlot(slotNum) {
  if (buscandoMoedaMutex) return;
  const slot = autoBotState.slots[slotNum];
  if (!slot || slot.isSearching) return;
  buscandoMoedaMutex = true;
  slot.isSearching = true;
  slot.status = 'PESQUISANDO_MOEDA_IA';

  const outroSlotNum = slotNum === 1 ? 2 : 1;
  const moedaOutroSlot = autoBotState.slots[outroSlotNum]?.symbol || autoBotState.slots[outroSlotNum]?.targetSymbol;

  try {
    const volData = await fut.ticker24h();
    if (!Array.isArray(volData)) throw new Error('Falha ao ler tickers 24h');

    // Filtra pares vetados pelo RAG (com 3 losses recentes seguidos nos últimos 5 trades)
    const vetadosRows = await db.all(`
      SELECT symbol, result FROM trades_rag WHERE result IS NOT NULL ORDER BY entry_time DESC LIMIT 100
    `).catch(() => []);
    const vetadosSet = new Set();
    const porSimbolo = {};
    for (const r of vetadosRows) {
      if (!porSimbolo[r.symbol]) porSimbolo[r.symbol] = [];
      porSimbolo[r.symbol].push(r.result);
    }
    for (const [s, results] of Object.entries(porSimbolo)) {
      if (results.slice(0, 5).filter(res => res === 'LOSS').length >= 3) {
        vetadosSet.add(s);
      }
    }

    // Filtra pares USDT, ignora lixo da testnet, moeda do outro slot e pares vetados pelo RAG
    const top = volData
      .filter(t => t.symbol.endsWith('USDT') && t.symbol !== 'HEMIUSDT' && t.symbol !== moedaOutroSlot && !vetadosSet.has(t.symbol))
      .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
      .slice(0, 5);

    if (top.length === 0) throw new Error('Sem pares disponíveis (todos em veto ou ativos)');

    // Busca memória RAG
    const memoriaRAG = await rag.obterMemoriaParaIA();

    // Coleta dados técnicos das 5 moedas em paralelo (0 tokens)
    const candidatos = await Promise.all(top.map(async (t) => {
      const sym = t.symbol;
      const dados = await coletarDadosMercado(sym);
      const varPct = parseFloat(t.priceChangePercent || 0).toFixed(2);
      if (!dados) return { symbol: sym, info: `${sym}: Var 24h: ${varPct}%, dados indisponíveis` };
      return {
        symbol: sym,
        info: `${sym}: Var 24h: ${varPct}%, Preço: ${dados.preco}, EMA(1m): ${dados.emaStatus}, SAR(1m): ${dados.sarTendencia}, RSI(15m): ${dados.rsi}, Funding: ${(dados.fundingRate * 100).toFixed(4)}%, VolRatio: ${dados.volRatio}x, Padrões: ${dados.padroesDetectados.join('/') || 'Nenhum'}`
      };
    }));

    const listaStr = candidatos.map((c, i) => `${i + 1}. ${c.info}`).join('\n');

    const prompt = `Você é o estrategista quantitativo autônomo do Slot ${slotNum} em Binance Futures.
O slot está vago e busca a MELHOR moeda volátil do momento para operar de forma contínua.

${memoriaRAG}

PARES CANDIDATOS DISPONÍVEIS (OUTRO SLOT OPERA: ${moedaOutroSlot || 'NENHUM'}):
${listaStr}

DIRETRIZES DE DECISÃO:
1. Escolha a moeda com maior probabilidade técnica ou armadilha de exaustão clara.
2. Tese:
   - "TENDENCIA": rompimento ou continuação a favor do fluxo.
   - "ARMADILHA_CONTRARIA": mercado eufórico no topo com funding caro ou exausto no fundo com funding negativo. Direção contrária.
3. Direção: "BUY" ou "SELL".
4. Alavancagem: 2x a 5x (teto máximo 5x).
   REGRA EXPRESSA: Use 1x SOMENTE em casos extremos de altíssimo risco e volatilidade descontrolada! Em situações normais, use 2x a 5x.
5. Gatilho Score Mínimo: 65 a 80.

Responda EXCLUSIVAMENTE em formato JSON (sem markdown):
{
  "symbol": "${candidatos[0].symbol}",
  "tese": "TENDENCIA",
  "direcao": "BUY",
  "alavancagem": 4,
  "gatilho_score": 70,
  "motivo": "resumo curto max 8 palavras"
}`;

    const r = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: "ag/gemini-3.8-flash-low",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.1,
      stream: false
    }, {
      headers: { "Authorization": `Bearer ${routerApiKey}` },
      timeout: 35000
    });

    registrarUsoTokens(r.data?.usage);

    const content = r.data?.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      let escolhido = String(parsed.symbol || '').toUpperCase().trim();
      const valid = candidatos.map(c => c.symbol);
      if (!valid.includes(escolhido)) escolhido = valid[0];

      let alav = parseInt(parsed.alavancagem) || 4;
      if (alav < 1) alav = 1;
      if (alav > 5) alav = 5;

      slot.targetSymbol = escolhido;
      slot.plano = {
        tese: parsed.tese || 'TENDENCIA',
        direcao: String(parsed.direcao || 'BUY').toUpperCase().trim(),
        alavancagem: alav,
        gatilho_score: parseInt(parsed.gatilho_score) || 70,
        motivo: parsed.motivo || 'Estratégia Slot'
      };
      slot.searchTime = Date.now();
      slot.status = 'AGUARDANDO_GATILHO';
      autoBotState.lastLog = `Slot ${slotNum}: IA alocou ${escolhido} (${slot.plano.direcao} ${slot.plano.alavancagem}x | ${slot.plano.tese}) - ${slot.plano.motivo}`;
      console.log(`[AUTOBOT-SLOT ${slotNum}] Alocada nova moeda ${escolhido}:`, JSON.stringify(slot.plano));
      return;
    }
  } catch(e) {
    console.error(`[AUTOBOT-SLOT ${slotNum}] Falha ao buscar moeda pela IA:`, e.message);
  } finally {
    slot.isSearching = false;
    buscandoMoedaMutex = false;
  }

  // Fallback se IA falhar
  const fallback = slotNum === 1 ? 'BTCUSDT' : 'ETHUSDT';
  slot.targetSymbol = fallback;
  slot.plano = { tese: 'TENDENCIA', direcao: 'BUY', alavancagem: 3, gatilho_score: 70, motivo: 'Fallback' };
  slot.searchTime = Date.now();
  slot.status = 'AGUARDANDO_GATILHO';
  slot.isSearching = false;
  buscandoMoedaMutex = false;
}

async function consultarIASegurancaLucro(symbol, pos, roi, peakRoi) {
  try {
    const dados = await coletarDadosMercado(symbol);
    const rsi15 = dados ? dados.rsi : '--';
    const emaStatus = dados ? dados.emaStatus : '--';
    const volRatio = dados ? dados.volRatio : '1.0';
    const prompt = `Você é um gestor quantitativo de segurança e realização de lucro em futuros Binance.
Posição aberta em ${pos.lado} no par ${symbol} (Alavancagem: ${pos.alavancagem}x).
- Entrada: ${pos.precoEntrada} | Preço Atual: ${dados ? dados.preco : '--'}
- LUCRO REAL ATUAL: +${roi.toFixed(2)}% ROI (Pico atingido: +${(peakRoi || roi).toFixed(2)}% ROI).
- Tendência 1m: ${emaStatus} | RSI 15m: ${rsi15} | Volume Ratio: ${volRatio}x.

Objetivo: Proteger o lucro conquistado e evitar devolução para o mercado.
Avalie se o movimento ainda tem fluxo e força para expandir ganho ("CONTINUAR") ou se perdeu fôlego/corre risco de rejeição ("FECHAR").
Responda EXCLUSIVAMENTE uma única palavra: CONTINUAR ou FECHAR.`;

    const r = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: "ag/gemini-3.5-flash-low",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
      stream: false
    }, { headers: { "Authorization": `Bearer ${routerApiKey}` }, timeout: 15000 });

    registrarUsoTokens(r.data?.usage);

    const txt = (r.data?.choices?.[0]?.message?.content || '').toUpperCase();
    return txt.includes('FECHAR') ? 'FECHAR' : 'CONTINUAR';
  } catch(e) {
    return 'CONTINUAR';
  }
}

async function consultarIAPerdao30m(symbol, pos, roi, duracaoMin) {
  try {
    const [dados, klines30m] = await Promise.all([
      coletarDadosMercado(symbol),
      fut.klines(symbol, '1m', 30).catch(() => [])
    ]);

    let amplitudePct = 0;
    if (klines30m && klines30m.length >= 10) {
      const highs = klines30m.map(k => parseFloat(k[2]));
      const lows = klines30m.map(k => parseFloat(k[3]));
      const maxH = Math.max(...highs);
      const minL = Math.min(...lows);
      if (minL > 0) amplitudePct = ((maxH - minL) / minL) * 100;
    }

    const rsi15 = dados ? dados.rsi : '--';
    const emaStatus = dados ? dados.emaStatus : '--';
    const volRatio = dados ? dados.volRatio : '1.0';
    const fundingPct = dados ? (dados.fundingRate * 100).toFixed(4) : '0';

    const prompt = `Você é um gestor quantitativo de risco e saída cirúrgica em Binance Futures.
A ordem está aberta há ${Math.round(duracaoMin)} minutos no par ${symbol} (${pos.lado} ${pos.alavancagem}x).
- Preço Entrada: ${pos.precoEntrada} | Preço Atual: ${dados ? dados.preco : '--'}
- ROI Atual: ${roi.toFixed(2)}%
- Comportamento dos últimos 30m: Amplitude de preço de apenas ${amplitudePct.toFixed(2)}%
- Volume relativo atual: ${volRatio}x (Médias: ${emaStatus})
- RSI 15m: ${rsi15} | Funding Rate: ${fundingPct}%

Avalie especificamente este cenário após 30 minutos:
- Se o ativo está travado/estagnado (sem volatilidade), volume secou, sangrando taxa de funding ou a tese inicial falhou sem perspectiva clara de alvo -> Responda FECHAR_PERDAO.
- Se o ativo ainda respeita suporte/resistência, mantém liquidez e há chance real de reversão/alvo -> Responda MANTER.

Responda EXCLUSIVAMENTE uma única palavra: FECHAR_PERDAO ou MANTER.`;

    const r = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: "ag/gemini-3.5-flash-low",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 50,
      temperature: 0.1,
      stream: false
    }, { headers: { "Authorization": `Bearer ${routerApiKey}` }, timeout: 15000 });

    registrarUsoTokens(r.data?.usage);

    const txt = (r.data?.choices?.[0]?.message?.content || '').toUpperCase();
    return txt.includes('FECHAR_PERDAO') ? 'FECHAR_PERDAO' : 'MANTER';
  } catch(e) {
    return 'MANTER';
  }
}

async function consultarIASaida(symbol, pos, roi, peakRoi) {
  return consultarIASegurancaLucro(symbol, pos, roi, peakRoi);
}

async function consultarIAEntrada(symbol, dadosMercado) {
  const prompt = `Você é um trader quantitativo profissional de alta precisão em Binance Futures (operações curtas de 9 minutos).
Analise todos os dados técnicos, fluxo de ordens, Fibonacci e padrões de candlesticks para o par ${symbol}:

1. DADOS DE PREÇO E FLUXO:
- Preço Atual: ${dadosMercado.preco}
- Funding Rate: ${(dadosMercado.fundingRate * 100).toFixed(4)}% (penalizar long se funding muito alto, penalizar short se muito negativo)
- Livro de Ofertas: ${dadosMercado.longPct}% Long vs ${dadosMercado.shortPct}% Short
- Volume Ratio: ${dadosMercado.volRatio}x da média das últimas 20 velas
- Volatilidade ATR (1m): ${dadosMercado.atr}

2. TENDÊNCIA E MÉDIAS MÓVEIS (1m e 15m):
- Médias Rápidas (1m): EMA9=${dadosMercado.ema9} vs EMA21=${dadosMercado.ema21} (${dadosMercado.emaStatus})
- Parabolic SAR (1m): ${dadosMercado.sarTendencia}
- RSI (15m): ${dadosMercado.rsi} (${dadosMercado.trend})

3. NÍVEIS DE FIBONACCI (Último Swing 1m):
- Topo Swing: ${dadosMercado.fiboHigh} | Fundo Swing: ${dadosMercado.fiboLow}
- Retração 0.382: ${dadosMercado.fib382} | 0.500: ${dadosMercado.fib500} | 0.618 (Golden Pocket): ${dadosMercado.fib618}
- Posição atual em relação a Fibonacci: ${dadosMercado.fiboPos}

4. PADRÕES DE VELAS DETECTADOS:
- Padrões identificados: ${dadosMercado.padroesDetectados.join(', ') || 'Nenhum padrão isolado clássico'}
- Últimas 5 velas 1m (O, H, L, C, V):
${dadosMercado.ohlcvSummary}

Critérios rigorosos:
- Se houver divergência grave ou indecisão (Doji, briga nas médias), responda "AGUARDAR" com score baixo.
- Se houver confluência (ex: Martelo ou Engolfo no 0.618 de Fibo com EMA9>EMA21 e fluxo comprador), autorize com score alto.
- Alavancagem: 1x a 10x baseada na volatilidade e risco (se ATR alto, seja conservador 2x-5x; se tendência limpa e segura, 6x-10x).

Responda EXCLUSIVAMENTE em formato JSON (sem markdown):
{"decisao": "BUY", "alavancagem": 5, "score": 85, "padrao": "Engolfo no 61.8 Fibo", "motivo": "resumo curto max 8 palavras"}
Decisao permitida: "BUY", "SELL" ou "AGUARDAR". Score de 0 a 100.`;

  try {
    const r = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: "ag/gemini-3.8-flash-high",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 350,
      temperature: 0.1,
      stream: false
    }, {
      headers: { "Authorization": `Bearer ${routerApiKey}` },
      timeout: 35000
    });

    const content = r.data?.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      let alav = parseInt(parsed.alavancagem) || 1;
      if (alav < 1) alav = 1;
      if (alav > 10) alav = 10;
      let score = parseInt(parsed.score) || 50;
      let dec = String(parsed.decisao).toUpperCase().trim();
      if (!['BUY', 'SELL', 'AGUARDAR'].includes(dec)) dec = 'AGUARDAR';
      return { decisao: dec, alavancagem: alav, score, padrao: parsed.padrao || '', motivo: parsed.motivo || '' };
    }
  } catch(e) {
    console.error(`[AUTOBOT-IA] Erro ao consultar IA para ${symbol}:`, e.message);
  }
  return { decisao: 'AGUARDAR', alavancagem: 1, score: 0, padrao: '', motivo: 'Falha ou indecisao' };
}

async function coletarDadosMercado(symbol) {
  try {
    const [precoData, velas15m, velas1m, gaugeRes] = await Promise.all([
      fut.tickerPreco(symbol).catch(() => null),
      fut.klines(symbol, '15m', 20).catch(() => []),
      fut.klines(symbol, '1m', 30).catch(() => []),
      axios.get(`http://127.0.0.1:7005/api/gauge/${symbol}`, {
        headers: { 'Authorization': 'Basic ' + Buffer.from('x:' + SENHA).toString('base64') }
      }).catch(() => ({ data: { success: false } }))
    ]);

    const preco = precoData && precoData.price ? parseFloat(precoData.price) : 0;
    let rsiVal = '--';
    let trend = 'NEUTRA';
    if (velas15m && velas15m.length >= 14) {
      const closes = velas15m.map(v => parseFloat(v[4]));
      const rsiArr = ti.RSI.calculate({ period: 14, values: closes });
      if (rsiArr.length) {
        const lastRsi = rsiArr[rsiArr.length - 1];
        rsiVal = lastRsi.toFixed(1);
        if (lastRsi > 70) trend = 'SOBRECOMPRADA';
        else if (lastRsi < 30) trend = 'SOBREVENDIDA';
        else if (lastRsi > 55) trend = 'FORCA DE COMPRA';
        else if (lastRsi < 45) trend = 'FORCA DE VENDA';
      }
    }

    // Parsing velas 1m
    const opens = (velas1m || []).map(v => parseFloat(v[1]));
    const highs = (velas1m || []).map(v => parseFloat(v[2]));
    const lows = (velas1m || []).map(v => parseFloat(v[3]));
    const closes = (velas1m || []).map(v => parseFloat(v[4]));
    const volumes = (velas1m || []).map(v => parseFloat(v[5]));

    let sarTendencia = 'NEUTRO';
    if (highs.length >= 10) {
      const psarArr = ti.PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });
      if (psarArr.length) {
        const lastPsar = psarArr[psarArr.length - 1];
        const lastClose = closes[closes.length - 1];
        sarTendencia = lastPsar > lastClose ? 'BAIXA (SAR acima)' : 'ALTA (SAR abaixo)';
      }
    }

    // EMAs 9 e 21
    let ema9 = '--', ema21 = '--', emaStatus = 'INDEFINIDO';
    if (closes.length >= 21) {
      const e9Arr = ti.EMA.calculate({ period: 9, values: closes });
      const e21Arr = ti.EMA.calculate({ period: 21, values: closes });
      if (e9Arr.length && e21Arr.length) {
        const lastE9 = e9Arr[e9Arr.length - 1];
        const lastE21 = e21Arr[e21Arr.length - 1];
        ema9 = lastE9.toFixed(4);
        ema21 = lastE21.toFixed(4);
        emaStatus = lastE9 > lastE21 ? 'ALTA (EMA9 > EMA21)' : 'BAIXA (EMA9 < EMA21)';
      }
    }

    // ATR (Volatilidade)
    let atrVal = '--';
    if (highs.length >= 14) {
      const atrArr = ti.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      if (atrArr.length) atrVal = atrArr[atrArr.length - 1].toFixed(4);
    }

    // Volume Ratio (última vela vs média das últimas 20)
    let volRatio = '1.0';
    if (volumes.length >= 20) {
      const lastVol = volumes[volumes.length - 1];
      const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      if (avgVol > 0) volRatio = (lastVol / avgVol).toFixed(2);
    }

    // Fibonacci Swing (últimas 20 velas)
    let fiboHigh = preco, fiboLow = preco, fib382 = preco, fib500 = preco, fib618 = preco, fiboPos = 'Médio';
    if (highs.length >= 20) {
      const recentHighs = highs.slice(-20);
      const recentLows = lows.slice(-20);
      fiboHigh = Math.max(...recentHighs);
      fiboLow = Math.min(...recentLows);
      const diff = fiboHigh - fiboLow;
      if (diff > 0) {
        fib382 = (fiboHigh - diff * 0.382).toFixed(4);
        fib500 = (fiboHigh - diff * 0.500).toFixed(4);
        fib618 = (fiboHigh - diff * 0.618).toFixed(4);
        const dist618 = Math.abs(preco - fib618) / preco;
        if (dist618 < 0.003) fiboPos = 'Exato no Golden Pocket (0.618)';
        else if (preco > fib500) fiboPos = 'Zona de Expansão Superior (>0.500)';
        else fiboPos = 'Zona de Suporte Inferior (<0.500)';
      }
    }

    // Padrões de Candlesticks automatizados
    const padroes = [];
    if (opens.length >= 5) {
      const inData = { open: opens, high: highs, low: lows, close: closes };
      if (ti.bullishengulfingpattern(inData)) padroes.push('Engolfo de Alta');
      if (ti.bearishengulfingpattern(inData)) padroes.push('Engolfo de Baixa');
      if (ti.hammerpattern(inData)) padroes.push('Martelo (Reversão Alta)');
      if (ti.shootingstar(inData)) padroes.push('Estrela Cadente (Reversão Baixa)');
      if (ti.morningstar(inData)) padroes.push('Estrela da Manhã (Forte Alta)');
      if (ti.eveningstar(inData)) padroes.push('Estrela do Anoitecer (Forte Baixa)');
      if (ti.threewhitesoldiers(inData)) padroes.push('Três Soldados Brancos (Alta Contínua)');
      if (ti.threeblackcrows(inData)) padroes.push('Três Corvos Pretos (Baixa Contínua)');
      if (ti.doji(inData)) padroes.push('Doji (Indecisão)');
    }

    // Resumo OHLCV das últimas 5 velas
    const nVelas = Math.min(5, opens.length);
    let ohlcvSummary = '';
    for (let i = opens.length - nVelas; i < opens.length; i++) {
      ohlcvSummary += `Candle ${i - opens.length + nVelas + 1}: Open=${opens[i]}, High=${highs[i]}, Low=${lows[i]}, Close=${closes[i]}, Vol=${volumes[i]}\n`;
    }

    const gData = gaugeRes.data || {};
    const longPct = gData.longPct !== undefined ? gData.longPct : 50;
    const shortPct = gData.shortPct !== undefined ? gData.shortPct : 50;
    const fundingRate = gData.fundingRate || 0;
    const recentCloses = closes.slice(-10);

    return {
      preco, rsi: rsiVal, trend, sarTendencia,
      ema9, ema21, emaStatus, atr: atrVal, volRatio,
      fiboHigh, fiboLow, fib382, fib500, fib618, fiboPos,
      padroesDetectados: padroes, ohlcvSummary,
      longPct, shortPct, fundingRate, recentCloses
    };
  } catch(e) {
    return null;
  }
}

async function verificarSARPosicao(symbol) {
  try {
    const raw = await fut.klines(symbol, '1m', 20);
    if (!raw || raw.length < 10) return null;
    const highs = raw.map(v => parseFloat(v[2]));
    const lows = raw.map(v => parseFloat(v[3]));
    const closes = raw.map(v => parseFloat(v[4]));
    const psarArr = ti.PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });
    if (!psarArr.length) return null;
    const lastPsar = psarArr[psarArr.length - 1];
    const lastClose = closes[closes.length - 1];
    return lastPsar > lastClose ? 'BEAR' : 'BULL';
  } catch(e) {
    return null;
  }
}

async function executarOrdemRobo(symbol, lado, valorUSDT, alavancagem) {
  const alav = Math.min(5, Math.max(1, parseInt(alavancagem) || 1));
  registrarMetaTrade(symbol, lado, alav);
  await fut.garantirAlavancagem(symbol, alav, 'ISOLATED');
  
  const book1 = await fut.livroOfertas(symbol, 5);
  const preco1 = parseFloat(lado === 'BUY' ? (book1.asks[0] || [])[0] : (book1.bids[0] || [])[0]);
  if (!preco1) throw new Error('Livro vazio');
  const calc1 = fut.calcularQuantidade(symbol, parseFloat(valorUSDT), preco1, alav);
  if (!calc1.ok) throw new Error(calc1.motivo);

  let ord1 = await fut.colocarLimite(symbol, lado, calc1.qty, preco1);
  await new Promise(r => setTimeout(r, 1200));
  try { await fut.cancelarOrdem(symbol, ord1.orderId); } catch(e){}
  let st1 = await fut.consultarOrdem(symbol, ord1.orderId);
  let fill1 = parseFloat(st1.executedQty) || 0;

  const armarStop = async () => {
    try {
      localAlvos[symbol] = { tp: null, sl: 10 };
      salvarAlvos();
      const pos = await fut.posicao(symbol);
      if (pos && pos.quantidade > 0) {
        const pEntrada = pos.precoEntrada;
        const pctSL = 0.10 / alav; // 10% de ROI
        const pStop = pos.lado === 'LONG' ? pEntrada * (1 - pctSL) : pEntrada * (1 + pctSL);
        await fut.colocarStopLoss(symbol, pos.lado, pStop).catch(() => {});
      }
    } catch(e) { console.error('[AUTOBOT] Erro SL:', e.message); }
  };

  if (st1.status === 'FILLED' || fill1 >= calc1.qty) {
    await armarStop();
    return { ok: true, qty: calc1.qty };
  }

  let qtyFalta = calc1.qty - fill1;
  if (qtyFalta * preco1 < 6) {
    await armarStop();
    return { ok: fill1 > 0, qty: fill1 };
  }

  const book2 = await fut.livroOfertas(symbol, 5);
  const preco2 = parseFloat(lado === 'BUY' ? (book2.asks[0] || [])[0] : (book2.bids[0] || [])[0]);
  if (Math.abs(preco2 - preco1) / preco1 > 0.003) {
    await armarStop();
    return { ok: fill1 > 0, qty: fill1 };
  }

  let ord2 = await fut.colocarLimite(symbol, lado, qtyFalta, preco2);
  await new Promise(r => setTimeout(r, 1200));
  try { await fut.cancelarOrdem(symbol, ord2.orderId); } catch(e){}
  let st2 = await fut.consultarOrdem(symbol, ord2.orderId);
  let fill2 = parseFloat(st2.executedQty) || 0;
  await armarStop();

  return { ok: (fill1 + fill2) > 0, qty: fill1 + fill2 };
}

let autoBotLoopRunning = false;

// Loop principal do bot autônomo (roda a cada 3s)
setInterval(async () => {
  if (!autoBotState.enabled) return;
  if (autoBotLoopRunning) return;
  autoBotLoopRunning = true;

  try {
    const now = Date.now();

    for (const slotNum of [1, 2]) {
      const slot = autoBotState.slots[slotNum];

      // CENÁRIO 1: Slot com posição aberta -> monitora posição e aplica Camada Inteligente de Lucro
      if (slot.symbol) {
        try {
          const pos = await fut.posicao(slot.symbol);
          if (!pos || pos.quantidade === 0) {
            slot.symbol = null;
            slot.side = null;
            slot.targetSymbol = null;
            slot.plano = null;
            slot.status = 'POSICAO_FECHADA_BUSCANDO';
            continue;
          }

          const margem = pos.margem || ((pos.quantidade * pos.precoEntrada) / (pos.alavancagem || 1));
          const roiAtual = margem > 0 ? (pos.pnlNaoRealizado / margem) * 100 : 0;
          slot.status = `ATIVO_${pos.lado}_${pos.alavancagem}X (ROI ${roiAtual.toFixed(1)}%)`;

          // CAMADA INTELIGENTE DE SEGURANÇA DO LUCRO:
          // Se ROI >= +2.0%, avalia a cada 30s se continua surfando ou protege o ganho
          // Se perda (negativo) ou < 2%, a IA NÃO corta (deixa oscilar até -10% SL)
          if (roiAtual >= 2.0) {
            if (now - (slot.lastIaProfitCheck || 0) >= 30000) {
              slot.lastIaProfitCheck = now;
              const peakRoi = maxRoiTracker[slot.symbol] || roiAtual;
              console.log(`[AUTOBOT-LUCRO] Slot ${slotNum} (${slot.symbol}): ROI em +${roiAtual.toFixed(2)}% (>=2%). Consultando IA...`);
              const decisaoLucro = await consultarIASegurancaLucro(slot.symbol, pos, roiAtual, peakRoi);
              if (decisaoLucro === 'FECHAR') {
                console.log(`[AUTOBOT-LUCRO] Slot ${slotNum}: IA recomendou FECHAR e proteger ganho em ${slot.symbol} (+${roiAtual.toFixed(2)}% ROI)!`);
                await fut.cancelarTodasOrdens(slot.symbol);
                await fut.fecharMercado(slot.symbol, pos.lado, pos.quantidade);

                await rag.salvarSaidaRAG({
                  symbol: slot.symbol,
                  exitPrice: pos.precoEntrada ? (pos.precoEntrada * (1 + (roiAtual / 100 / (pos.alavancagem || 1)))) : 0,
                  exitReason: 'IA_PROFIT_PROTECTION',
                  roiPct: roiAtual,
                  pnlUsdt: pos.pnlNaoRealizado
                }).catch(() => {});

                delete localAlvos[slot.symbol];
                delete maxRoiTracker[slot.symbol];
                salvarAlvos();

                const symFechado = slot.symbol;
                slot.symbol = null;
                slot.side = null;
                slot.targetSymbol = null;
                slot.plano = null;
                slot.searchCooldownUntil = now + 45000; // Cooldown 45s pós-saída
                slot.status = 'LUCRO_PROTEGIDO_COOLDOWN_45S';
                autoBotState.lastLog = `Slot ${slotNum}: IA protegeu lucro em ${symFechado} (+${roiAtual.toFixed(1)}% ROI). Cooldown 45s ativado.`;
                continue;
              } else {
                console.log(`[AUTOBOT-LUCRO] Slot ${slotNum}: IA autorizou CONTINUAR em ${slot.symbol} (+${roiAtual.toFixed(2)}% ROI).`);
              }
            }
          }

          // REGRA DE PERDÃO APÓS 30 MINUTOS:
          // Se a ordem estiver aberta há mais de 30 minutos, avalia a cada 5 minutos
          const duracaoMs = now - (slot.openTime || now);
          if (duracaoMs >= 30 * 60 * 1000) {
            if (now - (slot.last30mCheck || 0) >= 5 * 60 * 1000) {
              slot.last30mCheck = now;
              const duracaoMin = duracaoMs / 60000;
              console.log(`[AUTOBOT-PERDAO] Slot ${slotNum} (${slot.symbol}): Aberto há ${Math.round(duracaoMin)} min (ROI: ${roiAtual.toFixed(2)}%). Consultando IA para avaliar estagnação/perdão...`);
              const decisaoPerdao = await consultarIAPerdao30m(slot.symbol, pos, roiAtual, duracaoMin);
              if (decisaoPerdao === 'FECHAR_PERDAO') {
                console.log(`[AUTOBOT-PERDAO] Slot ${slotNum}: IA decidiu FECHAR COM PERDÃO em ${slot.symbol} (aberto há ${Math.round(duracaoMin)}m, ROI: ${roiAtual.toFixed(2)}%)!`);
                await fut.cancelarTodasOrdens(slot.symbol);
                await fut.fecharMercado(slot.symbol, pos.lado, pos.quantidade);

                await rag.salvarSaidaRAG({
                  symbol: slot.symbol,
                  exitPrice: pos.precoEntrada ? (pos.precoEntrada * (1 + (roiAtual / 100 / (pos.alavancagem || 1)))) : 0,
                  exitReason: 'PERDAO_30M',
                  roiPct: roiAtual,
                  pnlUsdt: pos.pnlNaoRealizado
                }).catch(() => {});

                delete localAlvos[slot.symbol];
                delete maxRoiTracker[slot.symbol];
                salvarAlvos();

                const symFechado = slot.symbol;
                slot.symbol = null;
                slot.side = null;
                slot.targetSymbol = null;
                slot.plano = null;
                slot.searchCooldownUntil = now + 45000; // Cooldown 45s pós-saída
                slot.status = 'PERDAO_30M_COOLDOWN_45S';
                autoBotState.lastLog = `Slot ${slotNum}: IA encerrou ${symFechado} com perdão após ${Math.round(duracaoMin)}m (ROI: ${roiAtual.toFixed(1)}%). Cooldown 45s.`;
                continue;
              } else {
                console.log(`[AUTOBOT-PERDAO] Slot ${slotNum}: IA decidiu MANTER ${slot.symbol} (aberto há ${Math.round(duracaoMin)}m). Próxima avaliação em 5m.`);
              }
            }
          }
        } catch(e) {}
        continue;
      }

      // CENÁRIO 2: Slot vazio sem moeda alvo -> Pesquisa oportunidade respeitando cooldown de 45s
      if (!slot.targetSymbol) {
        if (!slot.isSearching && now >= (slot.searchCooldownUntil || 0)) {
          buscarMelhorMoedaParaSlot(slotNum).catch(() => {});
        } else if (now < (slot.searchCooldownUntil || 0)) {
          const segs = Math.round((slot.searchCooldownUntil - now) / 1000);
          slot.status = `COOLDOWN_RESPIRADA_${segs}S`;
        }
        continue;
      }

      // CENÁRIO 3: Slot com moeda alvo aguardando gatilho técnico local (0 tokens)
      const sym = slot.targetSymbol;
      const plano = slot.plano || { tese: 'TENDENCIA', direcao: 'BUY', alavancagem: 3, gatilho_score: 70, motivo: 'Plano' };

      // Descarte de moeda travada há mais de 8 minutos
      if (now - (slot.searchTime || now) > 8 * 60 * 1000) {
        console.log(`[AUTOBOT-SLOT ${slotNum}] Moeda ${sym} sem gatilho há 8 min. Descartando para buscar oportunidade fresca...`);
        autoBotState.lastLog = `Slot ${slotNum}: Descartando ${sym} por inatividade (>8 min). Buscando nova oportunidade...`;
        slot.targetSymbol = null;
        slot.plano = null;
        slot.status = 'DESCARTADO_POR_TEMPO';
        continue;
      }

      const dados = await coletarDadosMercado(sym);
      if (!dados) continue;

      // Gamificação dos Indicadores (0 tokens)
      const scoreRes = calcularScoreGamificado(dados, plano.direcao, plano.tese);
      slot.score = scoreRes.score;
      slot.mode = scoreRes.modo;
      slot.details = scoreRes.detalhes;

      // Consulta RAG
      const ragCheck = await rag.consultarHistoricoRAG({
        symbol: sym,
        side: scoreRes.sideExecucao,
        mode: scoreRes.modo,
        scoreTotal: scoreRes.score,
        fundingRate: dados.fundingRate,
        rsi15m: dados.rsi
      });

      if (ragCheck.veto) {
        console.log(`[AUTOBOT-RAG] Slot ${slotNum}: ${ragCheck.motivo}. Descartando ${sym} para buscar moeda limpa...`);
        autoBotState.lastLog = `Slot ${slotNum}: ${ragCheck.motivo}. Aguardando 45s...`;
        slot.targetSymbol = null;
        slot.plano = null;
        slot.searchCooldownUntil = now + 45000;
        slot.status = 'VETO_RAG_COOLDOWN_45S';
        continue;
      }

      const scoreMinimo = plano.gatilho_score || 70;
      if (scoreRes.score >= scoreMinimo) {
        // Cálculo de alavancagem: teto 5x, piso normal 2x (1x só em caso extremo)
        let alavFinal = plano.alavancagem || 4;
        if (scoreRes.cautelaMultiplicacao || scoreRes.modo === 'ARMADILHA_CONTRARIA') {
          alavFinal = Math.max(2, Math.min(3, alavFinal)); // cautela: 2x ou 3x
        } else if (ragCheck.ajusteAlavancagem) {
          alavFinal = Math.round(alavFinal * ragCheck.ajusteAlavancagem);
        }

        // Caso extremo: volatilidade ATR relativa > 2.5% do preço
        const isCasoExtremo = (parseFloat(dados.atr || 0) / (dados.preco || 1)) > 0.025;
        if (alavFinal < 2 && !isCasoExtremo) {
          alavFinal = 2; // piso 2x em operações normais
        }
        alavFinal = Math.min(5, Math.max(1, alavFinal)); // teto 5x absoluto

        const ladoOrdem = scoreRes.sideExecucao;
        console.log(`[AUTOBOT-GATILHO] Slot ${slotNum} Disparo em ${sym}! Modo: ${scoreRes.modo} | Score: ${scoreRes.score}/${scoreMinimo} | Lado: ${ladoOrdem} ${alavFinal}x | RAG: ${ragCheck.status}`);

        slot.status = 'EXECUTANDO_ORDEM';

        const execRes = await executarOrdemRobo(sym, ladoOrdem, 10, alavFinal);
        if (execRes.ok) {
          slot.symbol = sym;
          slot.openTime = now;
          slot.lastCheckTime = now;
          slot.side = ladoOrdem;
          slot.leverage = alavFinal;
          slot.margin = 10;
          slot.score = scoreRes.score;
          slot.padrao = scoreRes.detalhes;
          slot.motivo = plano.motivo || scoreRes.modo;
          slot.status = `ATIVO_${ladoOrdem}_${alavFinal}X`;

          await rag.salvarEntradaRAG({
            cycleId: 0,
            symbol: sym,
            side: ladoOrdem,
            leverage: alavFinal,
            mode: scoreRes.modo,
            scoreTotal: scoreRes.score,
            dadosMercado: dados,
            aiThesis: plano.motivo || scoreRes.modo,
            entryPrice: dados.preco
          }).catch(() => {});

          autoBotState.lastLog = `Slot ${slotNum}: ORDEM DISPARADA ${sym} (${ladoOrdem} ${alavFinal}x | Score ${scoreRes.score}) - Modo: ${scoreRes.modo}`;
        } else {
          slot.status = `FALHA_EXEC_${sym}`;
        }
      } else {
        slot.status = `AGUARDANDO (${scoreRes.score}/${scoreMinimo} pts)`;
      }
    }
  } catch(e) {
    console.error('[AUTOBOT] Erro no loop contínuo:', e.message);
  } finally {
    autoBotLoopRunning = false;
  }
}, 3000);

app.get('/api/auto-status', (req, res) => {
  res.json({
    success: true,
    enabled: autoBotState.enabled,
    cycleRemainingSeconds: 0,
    tokensGastos: tokensGastos.total || 0,
    tokensDetalhe: tokensGastos,
    slots: autoBotState.slots,
    lastLog: autoBotState.lastLog
  });
});

app.get('/api/rag-stats', async (req, res) => {
  try {
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(roi_pct) as avgRoi
      FROM trades_rag
      WHERE result IS NOT NULL
    `);
    const recent = await db.all(`
      SELECT symbol, side, mode, score_total, roi_pct, result, post_mortem, entry_time, exit_reason
      FROM trades_rag
      WHERE result IS NOT NULL
      ORDER BY id DESC LIMIT 10
    `);
    res.json({ success: true, stats, recent });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/auto-trade', async (req, res) => {
  const { enabled } = req.body;
  autoBotState.enabled = enabled === true;
  salvarAutoBotConfig(autoBotState.enabled);
  if (autoBotState.enabled) {
    autoBotState.lastLog = 'Robô Contínuo Ativado. Buscando moedas para os slots...';
    [1, 2].forEach(s => {
      autoBotState.slots[s].isSearching = false;
      if (!autoBotState.slots[s].symbol) {
        autoBotState.slots[s].targetSymbol = null;
        autoBotState.slots[s].plano = null;
        autoBotState.slots[s].status = 'BUSCANDO_MOEDA';
      }
    });
  } else {
    autoBotState.lastLog = 'Robô Autônomo Desativado pelo Painel.';
  }
  res.json({ success: true, enabled: autoBotState.enabled });
});

app.post('/api/limpar-placar', (req, res) => {
  marcoZero = Date.now();
  try { fs.writeFileSync(marcoZeroFile, marcoZero.toString()); } catch(e) {}
  salvarDobradinha({ winDobradinha: 0, lossDobradinha: 0 });
  res.json({ success: true });
});

app.get('/api/win-loss', async (req, res) => {
  try {
    const h = await fut.income({ startTime: marcoZero, limit: 1000 });
    let groups = [];
    (h || []).forEach(t => {
      if (t.symbol === 'HEMIUSDT' || t.time < marcoZero) return;
      const val = parseFloat(t.income);
      let placed = false;
      for (let g of groups) {
        if (g.symbol === t.symbol && Math.abs(g.time - t.time) < 60000) {
          if (t.incomeType === 'REALIZED_PNL') {
            g.pnl += val;
            g.hasPnl = true;
          }
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push({
          symbol: t.symbol,
          time: t.time,
          pnl: t.incomeType === 'REALIZED_PNL' ? val : 0,
          hasPnl: t.incomeType === 'REALIZED_PNL'
        });
      }
    });

    let wins = 0;
    let losses = 0;
    groups.forEach(g => {
      if (g.hasPnl) {
        if (g.pnl > 0) wins++;
        else if (g.pnl < 0) losses++;
      }
    });

    // Agrupamento temporal para cálculo de Dobradinhas (janela de 10 min)
    // Quando 2 trades ocorrem na mesma janela temporal:
    // Ambos > 0 -> Dobradinha Win (+1)
    // Ambos < 0 -> Dobradinha Loss (+1)
    let sortedTrades = groups.filter(g => g.hasPnl && Math.abs(g.pnl) > 0.0001).sort((a,b) => a.time - b.time);
    let winDobradinha = 0;
    let lossDobradinha = 0;
    let usedIndices = new Set();

    for (let i = 0; i < sortedTrades.length; i++) {
      if (usedIndices.has(i)) continue;
      for (let j = i + 1; j < sortedTrades.length; j++) {
        if (usedIndices.has(j)) continue;
        if (Math.abs(sortedTrades[j].time - sortedTrades[i].time) <= 12 * 60 * 1000) {
          if (sortedTrades[i].pnl > 0 && sortedTrades[j].pnl > 0) {
            winDobradinha++;
            usedIndices.add(i);
            usedIndices.add(j);
            break;
          } else if (sortedTrades[i].pnl < 0 && sortedTrades[j].pnl < 0) {
            lossDobradinha++;
            usedIndices.add(i);
            usedIndices.add(j);
            break;
          }
        }
      }
    }

    res.json({ success: true, wins, losses, winDobradinha, lossDobradinha, total: wins + losses });
  } catch(e) {
    res.json({ success: false, wins: 0, losses: 0, winDobradinha: 0, lossDobradinha: 0, error: e.message });
  }
});

// Retorna 10 velas de 1m + Parabolic SAR para o mini-gráfico
app.get('/api/candles1m/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // Pega 30 velas para ter dados suficientes para o PSAR aquecer, mas retorna só 10
    const raw = await fut.klines(symbol, '1m', 30);
    if (!raw || raw.length < 10) return res.json({ success: false, error: 'Dados insuficientes' });

    const highs  = raw.map(v => parseFloat(v[2]));
    const lows   = raw.map(v => parseFloat(v[3]));
    const opens  = raw.map(v => parseFloat(v[1]));
    const closes = raw.map(v => parseFloat(v[4]));
    const times  = raw.map(v => v[0]);

    // Calcula PSAR em toda a série (precisa de pelo menos ~10 candles para aquecer)
    const psarArr = ti.PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });

    // Alinha PSAR com os candles (a lib retorna menos valores que a entrada)
    const offset = raw.length - psarArr.length;

    // Pega só as últimas 10 velas
    const N = 10;
    const start = raw.length - N;
    const candles = [];
    for (let i = start; i < raw.length; i++) {
      const psarIdx = i - offset;
      const psar = (psarIdx >= 0 && psarIdx < psarArr.length) ? psarArr[psarIdx] : null;
      const open  = opens[i];
      const close = closes[i];
      const pct   = open !== 0 ? ((close - open) / open) * 100 : 0;
      candles.push({
        time:  times[i],
        open,
        high:  highs[i],
        low:   lows[i],
        close,
        pct:   parseFloat(pct.toFixed(2)),
        green: close >= open,
        psar,
        // SAR acima do preço = tendência de baixa -> seta pra baixo; SAR abaixo = tendência de alta -> seta pra cima
        sarAcima: psar !== null ? psar > close : null
      });
    }

    res.json({ success: true, candles });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro ? fut.detalheErro(err) : err.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>Futuros</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22 fill=%22%23D4AF37%22>$</text></svg>">
  <style>
    :root {
      --bg: #050814;
      --card: rgba(12, 14, 21, 0.85);
      --gold: #D4AF37;
      --blue: #1D4ED8;
      --green: #10B981;
      --red: #EF4444;
      --border: rgba(255, 255, 255, 0.08);
      --text: #F8FAFC;
      --text-muted: #94A3B8;
    }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); margin: 0; padding: 5px; min-height: 100vh; }
    h1 { text-align: center; color: var(--gold); font-size: 1rem; font-weight: 300; letter-spacing: 2px; text-transform: uppercase; margin: 5px 0 10px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 10px; max-width: 1000px; margin: 0 auto; }
    @media (min-width: 768px) { .grid { grid-template-columns: 1fr 1fr; } }
    .card { background: var(--card); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--border); border-radius: 10px; padding: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); cursor: pointer; transition: 0.3s; }
    .card.active { border-color: var(--gold); box-shadow: 0 0 20px rgba(212, 175, 55, 0.15); }
    
    .header-bar { max-width: 1000px; margin: 0 auto 8px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; }
    .header-bar span { font-size: 0.9rem; font-weight: bold; color: var(--gold); }
    .header-btns { display: flex; gap: 6px; }
    .header-btns button { padding: 5px 8px; font-size: 0.7rem; border-radius: 6px; background: rgba(255,255,255,0.1); }
    
    .volatility-bar { max-width: 1000px; margin: 0 auto 10px; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; scrollbar-color: var(--gold) rgba(0,0,0,0.3); }
    .volatility-bar::-webkit-scrollbar { height: 4px; }
    .volatility-bar::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); border-radius: 4px; }
    .volatility-bar::-webkit-scrollbar-thumb { background: var(--gold); border-radius: 4px; }
    .vol-item { flex-shrink: 0; background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 0.75rem; cursor: pointer; transition: 0.2s; }
    .vol-item:hover { border-color: var(--gold); background: rgba(212, 175, 55, 0.1); }
    .vol-item .sym { font-weight: bold; color: var(--text); }
    .vol-item .pct { font-weight: bold; margin-left: 5px; }
    
    .input-group { margin-bottom: 8px; position: relative; }
    .input-group input[type="text"], .input-group input[type="number"] { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--border); color: var(--gold); font-size: 0.9rem; padding: 8px; border-radius: 6px; outline: none; transition: all 0.3s; text-transform: uppercase; text-align: center; font-weight: bold; }
    .input-group input:focus { border-color: var(--gold); box-shadow: 0 0 10px rgba(212, 175, 55, 0.1); }
    .input-group input::placeholder { color: rgba(255,255,255,0.2); font-weight: normal; text-transform: none; }
    
    .range-group { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; background: rgba(0,0,0,0.2); padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); }
    .range-group label { flex: 1; font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; }
    .range-group input[type="range"] { flex: 2; accent-color: var(--gold); }
    .range-group span { font-size: 0.9rem; color: var(--gold); font-weight: bold; width: 30px; text-align: right; }
    
    .price-display { font-size: 1.2rem; text-align: center; margin: 2px 0 6px; font-weight: 200; color: var(--text); letter-spacing: 1px; }
    
    .candles-row { display: flex; justify-content: space-between; margin-bottom: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid var(--border); }
    .candle { display: flex; flex-direction: column; align-items: center; gap: 5px; }
    .candle-label { font-size: 0.7rem; color: var(--text-muted); font-weight: 500; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #334155; box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); transition: 0.5s all; }
    .dot.green { background: var(--green); box-shadow: 0 0 8px rgba(16, 185, 129, 0.4), inset 0 2px 4px rgba(255,255,255,0.3); }
    .dot.red { background: var(--red); box-shadow: 0 0 8px rgba(239, 68, 68, 0.4), inset 0 2px 4px rgba(255,255,255,0.3); }
    
    .therm-wrapper { margin-bottom: 15px; }
    .therm-label { font-size: 0.75rem; color: var(--text-muted); text-align: center; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 1px; }
    .therm-track { height: 5px; background: #1E293B; border-radius: 4px; overflow: hidden; position: relative; }
    .therm-fill { height: 100%; width: 50%; background: var(--blue); border-radius: 4px; transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background 0.6s; }
    
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
    button { padding: 12px; border: none; border-radius: 8px; font-size: 0.8rem; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: white; cursor: pointer; transition: all 0.2s; outline: none; }
    button:active { transform: scale(0.94); }
    .btn-buy { background: linear-gradient(135deg, #059669 0%, #10B981 100%); box-shadow: 0 4px 10px rgba(16, 185, 129, 0.2); }
    .btn-sell { background: linear-gradient(135deg, #DC2626 0%, #EF4444 100%); box-shadow: 0 4px 10px rgba(239, 68, 68, 0.2); }
    .btn-close { background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); box-shadow: 0 4px 10px rgba(245, 158, 11, 0.2); }
    .btn-reverse { background: linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%); box-shadow: 0 4px 10px rgba(139, 92, 246, 0.2); }
    
    .status { text-align: center; font-size: 0.75rem; color: var(--text-muted); min-height: 1.2rem; }
    
    .pos-card { background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 12px; display: none; }
    .pos-header { display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 5px; }
    .pos-pnl { font-size: 1.3rem; font-weight: bold; text-align: center; margin: 5px 0; }
    .text-green { color: var(--green); }
    .text-red { color: var(--red); }
    
    @keyframes piscaLuz {
      0% { opacity: 1; color: var(--gold); text-shadow: 0 0 10px var(--gold); }
      50% { opacity: 0.2; color: #FFF; text-shadow: none; }
      100% { opacity: 1; color: var(--gold); text-shadow: 0 0 10px var(--gold); }
    }
    .alerta-lucro { animation: piscaLuz 0.8s infinite; font-size: 0.65rem; font-weight: bold; margin-top: 5px; display: block; text-transform: uppercase; letter-spacing: 1px; }

    .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); display: none; justify-content: center; align-items: center; z-index: 999; }
    .modal { background: var(--bg); border: 1px solid var(--border); border-radius: 16px; width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto; padding: 20px; }
    .modal-head { display: flex; justify-content: space-between; margin-bottom: 20px; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 10px;}
    .day-block { margin-bottom: 15px; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
    .day-title { display: flex; justify-content: space-between; color: var(--gold); margin-bottom: 10px; font-weight: bold; }
    .trade-row { display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 5px; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 5px;}
    .hist-cards { display: flex; gap: 10px; margin-bottom: 15px; overflow-x: auto; }
    
    @media (max-width: 600px) {
      .header-bar { flex-direction: column; text-align: center; gap: 10px; padding: 15px; }
      .header-btns { width: 100%; justify-content: space-between; }
      .header-btns button { flex: 1; padding: 10px; }
      .card { padding: 12px; }
      .input-group input[type="text"], .input-group input[type="number"] { padding: 15px; font-size: 1.1rem; }
      .actions button { padding: 15px; font-size: 0.9rem; }
      .btn-close, .btn-reverse { padding: 12px !important; font-size: 0.8rem !important; }
      .hist-cards { flex-direction: column; gap: 8px; }
      .hist-cards > div { padding: 10px !important; display: flex; justify-content: space-between; align-items: center; text-align: right !important; }
      .hist-cards > div > div:first-child { text-align: left; font-size: 0.8rem !important; flex: 1; }
      .modal { height: 100vh; max-height: 100vh; border-radius: 0; padding: 15px 10px; width: 100% !important; }
      #hist-content { max-height: calc(100vh - 250px) !important; }
    }
    /* ── Mini-gráfico de Velas 1m ── */
    .velas-wrap { margin-bottom: 14px; }
    .velas-titulo { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
    .velas-svg-area { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 8px; padding: 6px 4px 2px; }
    .velas-svg { display: block; width: 100%; overflow: visible; }
    .velas-pct-row { display: flex; justify-content: space-between; margin-top: 2px; }
    .vela-pct { font-size: 0.6rem; font-weight: 600; text-align: center; flex: 1; white-space: nowrap; overflow: hidden; }
    .vela-pct.up   { color: #10B981; }
    .vela-pct.dn   { color: #EF4444; }
    .sar-arrow { font-size: 0.75rem; }
    .sar-arrow.up { color: #10B981; }
    .sar-arrow.dn { color: #EF4444; }

    @media (max-width: 600px) {
      .velas-svg { height: 56px; }
    }

  </style>
</head>
<body>
  <div style="display:flex; justify-content:center; align-items:center; gap:16px; margin: 10px 0 15px;">
    <h1 style="margin:0;">Futuros</h1>
    <div id="token-box" style="display:flex; align-items:center; gap:6px; background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.35); padding:5px 12px; border-radius:8px; font-size:0.8rem; color:#60a5fa; font-family:monospace;">
      <span>⚡ Gasto Tokens:</span> <b id="total-tokens-val" style="color:#fff; font-size:0.9rem;">0</b>
    </div>
  </div>
  
  <div class="header-bar">
    <div style="display:flex; flex-direction:column;">
       <div>Saldo: <span id="saldo-usdt">Calculando...</span> <span id="pnl-usdt" style="font-size:0.85rem; margin-left:5px;"></span></div>
       <div id="saldo-brl" style="font-size:0.75rem; color:var(--text-muted); margin-top:3px;"></div>
    </div>

    <!-- PLACAR DE ACERTOS / ERROS E DOBRADINHA -->
    <div style="display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.35); border:1px solid var(--border); padding:5px 10px; border-radius:8px; flex-wrap:wrap;">
       <span style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">Trades:</span>
       <span id="placar-wins" style="font-size:0.85rem; font-weight:bold; color:var(--green); background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.3); padding:2px 6px; border-radius:5px;">0 W</span>
       <span style="color:var(--text-muted); font-size:0.75rem;">/</span>
       <span id="placar-losses" style="font-size:0.85rem; font-weight:bold; color:var(--red); background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); padding:2px 6px; border-radius:5px;">0 L</span>

       <span style="font-size:0.7rem; color:var(--gold); text-transform:uppercase; letter-spacing:1px; margin-left:6px; border-left:1px solid rgba(255,255,255,0.15); padding-left:8px;">Dobradinha:</span>
       <span id="dobradinha-wins" title="Quando ambos acertaram no ciclo" style="font-size:0.85rem; font-weight:bold; color:var(--green); background:rgba(16,185,129,0.25); border:1px solid var(--green); padding:2px 6px; border-radius:5px;">0 2W</span>
       <span style="color:var(--text-muted); font-size:0.75rem;">/</span>
       <span id="dobradinha-losses" title="Quando ambos erraram no ciclo" style="font-size:0.85rem; font-weight:bold; color:var(--red); background:rgba(239,68,68,0.25); border:1px solid var(--red); padding:2px 6px; border-radius:5px;">0 2L</span>

       <button onclick="zerarPlacar()" title="Zerar contadores" style="padding:2px 6px; font-size:0.65rem; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:var(--text-muted); border-radius:4px; margin-left:4px; cursor:pointer;">ZERAR</button>
    </div>

    <div class="header-btns">
      <button onclick="carregarSaldo()">Atualizar</button>
      <button onclick="abrirHistorico()" style="background:var(--blue);">Histórico</button>
      <button onclick="sairDoPainel()" style="background:var(--red);">Sair</button>
    </div>
  </div>

  <!-- BARRA DE CONTROLE DO ROBÔ AUTÔNOMO -->
  <div style="max-width: 1000px; margin: 0 auto 8px; background: rgba(12, 14, 21, 0.95); border: 1px solid rgba(212, 175, 55, 0.3); border-radius: 10px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
      <button id="btn-auto-toggle" onclick="toggleAutoBot()" style="padding: 8px 16px; font-size: 0.8rem; border-radius: 6px; background: rgba(16, 185, 129, 0.2); border: 1px solid var(--green); color: var(--green); font-weight: bold; letter-spacing: 1px; cursor: pointer;">
        LIGAR ROBÔ IA
      </button>
      <div style="font-size: 0.8rem; color: var(--text);">
        Modo: <b id="auto-timer" style="color: var(--green); font-family: monospace;">CONTÍNUO</b>
        <span id="auto-status-text" style="margin-left: 10px; font-size: 0.75rem; color: var(--text-muted);">Robô Desligado</span>
      </div>
      <div style="font-size: 0.75rem; color: var(--gold); background: rgba(212, 175, 55, 0.1); border: 1px solid rgba(212, 175, 55, 0.3); padding: 3px 8px; border-radius: 4px;">
        🧠 RAG: <span id="auto-rag-badge" style="color: #fff; font-weight: bold;">--</span>
      </div>
      <div style="font-size: 0.75rem; color: #3b82f6; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); padding: 3px 8px; border-radius: 4px;">
        ⚡ Slots: <span style="color: #fff; font-weight: bold;">2 Autônomos</span>
      </div>
    </div>
    <div style="font-size: 0.75rem; color: var(--text-muted);" id="auto-log-text">Aguardando ativação...</div>
  </div>

  <div class="volatility-bar" id="vol-bar">
    <div style="font-size:0.8rem; color:var(--text-muted); padding: 10px;">Analisando volatilidade...</div>
  </div>

  <div class="modal-overlay" id="modal-hist">
    <div class="modal" style="max-width: 900px; width: 95%;">
      <div class="modal-head">
        <h3 style="margin:0; color:var(--gold);">Dashboard de Histórico</h3>
        <div>
          <button style="padding: 5px 10px; background:transparent; border:1px solid var(--text-muted); color:white;" onclick="fecharHistorico()">X</button>
        </div>
      </div>
      
      <div class="hist-cards">
        <div style="background:rgba(0,0,0,0.3); padding:15px; border-radius:8px; border:1px solid var(--border); flex:1; min-width:120px; text-align:center;">
          <div style="font-size:0.7rem; color:var(--text-muted);">LUCRO BRUTO</div>
          <div id="dh-bruto" style="font-size:1.2rem; color:var(--green); font-weight:bold;">--</div>
          <div id="dh-bruto-brl" style="font-size:0.7rem; color:var(--text-muted);">--</div>
        </div>
        <div style="background:rgba(0,0,0,0.3); padding:15px; border-radius:8px; border:1px solid var(--border); flex:1; min-width:120px; text-align:center;">
          <div style="font-size:0.7rem; color:var(--text-muted);">TAXAS (Fee/Comm)</div>
          <div id="dh-taxas" style="font-size:1.2rem; color:var(--red); font-weight:bold;">--</div>
          <div id="dh-taxas-brl" style="font-size:0.7rem; color:var(--text-muted);">--</div>
        </div>
        <div style="background:rgba(0,0,0,0.3); padding:15px; border-radius:8px; border:1px solid var(--border); flex:1; min-width:120px; text-align:center;">
          <div style="font-size:0.7rem; color:var(--text-muted);">LUCRO LÍQUIDO</div>
          <div id="dh-liq" style="font-size:1.2rem; color:var(--gold); font-weight:bold;">--</div>
          <div id="dh-liq-brl" style="font-size:0.7rem; color:var(--text-muted);">--</div>
        </div>
      </div>
      
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; align-items:center;">
        <input type="date" id="hist-date" style="padding:10px; border-radius:8px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:var(--gold); flex:1; max-width:160px;" onchange="renderHist()" title="Filtrar Dia Específico">
        <button onclick="filtrarHoje()" style="padding:10px; background:rgba(34,197,94,0.2); border:1px solid var(--green); color:var(--green); border-radius:8px; flex:1; max-width:80px;">Hoje</button>
        <button onclick="limparFiltro()" style="padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:var(--text); border-radius:8px; flex:1; max-width:90px;">Todas</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
        <button onclick="renderAgrupado('dia')" style="flex:1; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:var(--text); border-radius:8px; min-width:80px;">Diário</button>
        <button onclick="renderAgrupado('semana')" style="flex:1; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:var(--text); border-radius:8px; min-width:80px;">Semanal</button>
        <button onclick="renderAgrupado('mes')" style="flex:1; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:var(--text); border-radius:8px; min-width:80px;">Mensal</button>
      </div>

      <div id="hist-content" style="max-height:400px; overflow-y:auto; font-size:0.85rem;">Carregando...</div>
    </div>
  </div>

  <div class="modal-overlay" id="modal-confirm" style="z-index: 1000;">
    <div class="modal" style="max-width: 400px; text-align: center;">
      <h2 id="mc-title" style="color:var(--gold); margin-top:0; letter-spacing:1px;">Confirmar</h2>
      <div id="mc-body" style="margin: 25px 0; color:var(--text); font-weight:300;"></div>
      <div style="display:flex; gap:15px; justify-content:center;">
        <button id="mc-btn-cancel" style="background:rgba(255,255,255,0.1); width:45%; color:var(--text-muted);" onclick="mcResolve(false)">CANCELAR</button>
        <button id="mc-btn-confirm" style="background:linear-gradient(135deg, #1D4ED8 0%, #2563EB 100%); box-shadow: 0 4px 15px rgba(29, 78, 216, 0.3); width:45%;" onclick="mcResolve(true)">CONFIRMAR</button>
      </div>
    </div>
  </div>

  <div class="grid">
    ${[1, 2].map(col => `
    <div class="card ${col === 1 ? 'active' : ''}" id="card-${col}" onclick="selecionarColuna(${col})">
      <div class="input-group">
        <input type="text" id="sym-${col}" placeholder="Moeda (ex: BTC)" oninput="debouncedLoad(${col})" autocomplete="off">
      </div>
      <div class="price-display" id="price-${col}">$ 0.0000</div>
      
      <div class="candles-row" id="candles-${col}">
        ${['1d','12h','6h','3h','1h','15m','1m'].map(tf => `
          <div class="candle">
            <span class="candle-label">${tf}</span>
            <div class="dot" id="dot-${col}-${tf}"></div>
          </div>
        `).join('')}
      </div>

      <div class="velas-wrap" id="velas-wrap-${col}">
        <div class="velas-titulo">Velas 1m · últimas 10</div>
        <div class="velas-svg-area">
          <svg id="velas-svg-${col}" class="velas-svg" height="68" viewBox="0 0 220 68" preserveAspectRatio="none"></svg>
        </div>
        <div class="velas-pct-row" id="velas-pct-${col}"></div>
      </div>
      
      <div class="therm-wrapper">
        <div class="therm-label">Força Compradora</div>
        <div class="therm-track">
          <div class="therm-fill" id="therm-${col}"></div>
        </div>
      </div>
      
      <!-- SINAL IA -->
      <div style="background:rgba(0,0,0,0.2); border:1px solid var(--border); border-radius:12px; padding:10px 15px; margin-bottom:15px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">RSI (15m)</div>
          <div id="rsi-${col}" style="font-weight:bold; font-size:1.1rem; color:var(--text);">--</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Padrão Técnico</div>
          <div id="trend-${col}" style="font-weight:bold; font-size:0.9rem;">--</div>
        </div>
      </div>
      
      <!-- POSIÇÃO ABERTA -->
      <div class="pos-card" id="pos-${col}">
        <div class="pos-header">
          <span id="pos-lado-${col}" style="font-weight:bold;">--</span>
          <span id="pos-qty-${col}">--</span>
        </div>
        <div class="pos-pnl" id="pos-pnl-${col}">$ 0.00</div>
        <div id="pos-pnl-brl-${col}" style="text-align:center; font-size:0.8rem; color:#3b82f6; margin-top:-5px; margin-bottom:5px;"></div>
        <div style="font-size:0.75rem; color:var(--text-muted); text-align:center;">Entrada: <span id="pos-entry-${col}">0</span></div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn-close" style="flex:1; padding:10px; font-size:0.75rem;" onclick="fecharPosicao(${col})">FECHAR MKT</button>
          <button class="btn-reverse" style="flex:1; padding:10px; font-size:0.75rem;" onclick="reverterPosicao(${col})">REVERTER</button>
        </div>
        <div style="margin-top:15px; background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:8px; padding:10px;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-align:center; margin-bottom:8px;">AJUSTAR ALVOS (%)</div>
          <div style="display:flex; gap:10px;">
             <input type="number" id="tp-${col}" placeholder="TP %" style="flex:1; padding:8px; font-size:0.9rem; background:rgba(255,255,255,0.05); border:1px solid var(--border); color:var(--green); border-radius:6px; text-align:center;">
             <input type="number" id="sl-${col}" placeholder="SL %" value="10" style="flex:1; padding:8px; font-size:0.9rem; background:rgba(255,255,255,0.05); border:1px solid var(--border); color:var(--red); border-radius:6px; text-align:center;">
          </div>
          <button style="width:100%; padding:10px; margin-top:10px; font-size:0.75rem; background:var(--blue); border-radius:6px;" onclick="aplicarTPSL(${col})">APLICAR TP/SL</button>
        </div>
      </div>
      
      <div class="range-group">
        <label>Alavancagem</label>
        <input type="range" id="alav-${col}" min="1" max="5" value="1" oninput="document.getElementById('alav-val-${col}').innerText = this.value + 'x'">
        <span id="alav-val-${col}">1x</span>
      </div>
      
      <div class="input-group" style="margin-bottom: 15px;">
        <input type="number" id="val-${col}" placeholder="Tamanho (USDT)" style="font-size:1rem; padding:12px;">
      </div>

      <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:var(--text-muted); margin-bottom:8px; padding:0 4px; text-transform:uppercase;">
        <div>Book: <span id="gauge-book-${col}" style="color:#FFF;">--</span></div>
        <div>Fund: <span id="gauge-fund-${col}" style="color:#FFF;">--</span></div>
        <div>OI: <span id="gauge-oi-${col}" style="color:#FFF;">--</span></div>
      </div>
      
      <div class="actions">
        <button class="btn-buy" onclick="execTrade(${col}, 'BUY')" style="display:flex; flex-direction:column; align-items:center; gap:3px;">
          <span>LONG</span>
          <span id="gl-${col}" style="font-size:0.7rem; font-weight:normal; background:rgba(0,0,0,0.2); padding:2px 8px; border-radius:10px;">--%</span>
        </button>
        <button class="btn-sell" onclick="execTrade(${col}, 'SELL')" style="display:flex; flex-direction:column; align-items:center; gap:3px;">
          <span>SHORT</span>
          <span id="gs-${col}" style="font-size:0.7rem; font-weight:normal; background:rgba(0,0,0,0.2); padding:2px 8px; border-radius:10px;">--%</span>
        </button>
      </div>

      <div style="display:flex; gap:10px; margin-bottom:10px;">
         <button id="btn-ia-on-${col}" onclick="toggleAdvise(${col}, true)" style="flex:1; background:rgba(139,92,246,0.15); border:1px solid #8b5cf6; color:#a78bfa; padding:10px; font-size:0.75rem; border-radius:8px; font-weight:bold;">AUXÍLIO DE IA</button>
         <button id="btn-ia-off-${col}" onclick="toggleAdvise(${col}, false)" style="flex:1; background:rgba(0,0,0,0.3); border:1px solid var(--border); color:var(--text-muted); padding:10px; font-size:0.75rem; border-radius:8px; display:none; font-weight:bold;">DESLIGAR IA</button>
      </div>
      <div id="tarja-ia-${col}" style="display:none; margin-bottom:15px; padding:12px; background:rgba(139,92,246,0.15); border-left:4px solid #8b5cf6; border-radius:6px; font-size:0.85rem; color:#e9d5ff; font-weight:600; line-height:1.4;">
         Consultando...
      </div>
      
      <div class="status" id="status-${col}">Aguardando...</div>
    </div>
    `).join('')}
  </div>

  <script>
    let timers = {};
    let autoRefresh = {};
    let iaTimers = {};
    let iaRecommendation = {};
    let adviseTimers = {};
    let adviseCount = {1: 0, 2: 0};
    let adviseCooldown = {1: false, 2: false};
    let colAtiva = 1;
    
    function toggleAdvise(col, state) {
      if (adviseCooldown[col]) return; // Impede ligar durante o cooldown

      const btnOn = document.getElementById('btn-ia-on-'+col);
      const btnOff = document.getElementById('btn-ia-off-'+col);
      const tarja = document.getElementById('tarja-ia-'+col);
      
      if (state) {
         btnOn.style.display = 'none';
         btnOff.style.display = 'block';
         tarja.style.display = 'block';
         tarja.innerText = '🤖 Consultando padrão...';
         fetchAdvise(col);
         adviseTimers[col] = setInterval(() => fetchAdvise(col), 20000);
      } else {
         btnOn.style.display = 'block';
         btnOff.style.display = 'none';
         tarja.style.display = 'none';
         clearInterval(adviseTimers[col]);
      }
    }
    
    async function fetchAdvise(col) {
      if (adviseCooldown[col]) return;

      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';
      
      adviseCount[col]++;
      const contagem = '[' + adviseCount[col] + '/5]';

      try {
         const r = await fetch('/api/ia-advise/' + sym);
         const d = await r.json();
         if(d.success && d.advice) {
            document.getElementById('tarja-ia-'+col).innerText = '🤖 ' + contagem + ' ' + d.advice;
         }
      } catch(e) {}

      if (adviseCount[col] >= 5) {
         clearInterval(adviseTimers[col]);
         adviseCooldown[col] = true;
         
         const btnOn = document.getElementById('btn-ia-on-'+col);
         const btnOff = document.getElementById('btn-ia-off-'+col);
         const tarja = document.getElementById('tarja-ia-'+col);
         
         btnOff.style.display = 'none';
         btnOn.style.display = 'block';
         btnOn.innerText = '⏳ RECARREGANDO IA (2M)...';
         btnOn.disabled = true;
         btnOn.style.opacity = '0.5';
         
         tarja.innerText = '⏳ Limite de 5 sugestões atingido. Aguarde 2 minutos para recarregar.';
         
         setTimeout(() => {
            adviseCount[col] = 0;
            adviseCooldown[col] = false;
            btnOn.innerText = 'AUXÍLIO DE IA';
            btnOn.disabled = false;
            btnOn.style.opacity = '1';
            tarja.style.display = 'none';
         }, 120000);
      }
    }
    
    function sairDoPainel() {
      fetch('/', { headers: { 'Authorization': 'Basic YWJjOmRlZg==' } }) // Senha falsa
        .then(() => { window.location.href = window.location.origin; })
        .catch(() => { window.location.href = window.location.origin; });
    }

    function askConfirm(title, html, isAlert = false) {
      return new Promise(resolve => {
        document.getElementById('mc-title').innerText = title;
        document.getElementById('mc-body').innerHTML = html;
        document.getElementById('mc-btn-cancel').style.display = isAlert ? 'none' : 'block';
        document.getElementById('mc-btn-confirm').innerText = isAlert ? 'OK' : 'CONFIRMAR';
        document.getElementById('mc-btn-confirm').style.width = isAlert ? '100%' : '45%';
        document.getElementById('modal-confirm').style.display = 'flex';
        window.mcResolve = (res) => {
          document.getElementById('modal-confirm').style.display = 'none';
          resolve(res);
        };
      });
    }
    
    let historicoGlobal = null;
    let metadataGlobal = {};
    let brlGlobal = 5.0;
    let saldoGlobal = 0;

    function fmtDolar(val) {
      return '$ ' + parseFloat(val).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }
    function fmtBrl(val) {
      return 'R$ ' + parseFloat(val).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }

    async function carregarSaldo() {
      try {
        const r = await fetch('/api/saldo');
        const d = await r.json();
        if(d.success) {
          brlGlobal = d.brl || 5.0;
          saldoGlobal = d.saldo || 0;
          document.getElementById('saldo-usdt').innerText = fmtDolar(d.saldo);
          document.getElementById('saldo-brl').innerText = fmtBrl(d.saldo * brlGlobal);
          document.getElementById('saldo-brl').style.color = '#3b82f6';
          
          const pnl = d.pnlHoje || 0;
          const saldoInicial = d.saldo - pnl;
          let pct = 0;
          if (saldoInicial > 0) pct = (pnl / saldoInicial) * 100;
          const pnlEl = document.getElementById('pnl-usdt');
          if (Math.abs(pnl) < 0.0001) {
            pnlEl.innerText = '(0.00%)';
            pnlEl.style.color = 'var(--text-muted)';
          } else {
            const sinal = pnl > 0 ? '+' : '';
            pnlEl.innerText = \`(\${sinal}\${pct.toFixed(2)}% | \${sinal}$ \${Math.abs(pnl).toFixed(2)})\`;
            pnlEl.style.color = pnl > 0 ? 'var(--green)' : 'var(--red)';
          }
        }
      } catch(e) {}
    }
    
    async function abrirHistorico() {
      document.getElementById('modal-hist').style.display = 'flex';
      const box = document.getElementById('hist-content');
      box.innerHTML = 'Carregando...';
      try {
        const r = await fetch('/api/historico-completo');
        const d = await r.json();
        if(!d.success) { box.innerHTML = 'Erro: ' + d.error; return; }
        historicoGlobal = d.trades;
        metadataGlobal = d.metadata || {};
        if(d.brl) brlGlobal = d.brl;
        renderHist();
      } catch(e) {
        box.innerHTML = 'Falha ao buscar histórico.';
      }
    }
    
    function filtrarHoje() {
      const hoje = new Date();
      const y = hoje.getFullYear();
      const m = String(hoje.getMonth() + 1).padStart(2, '0');
      const d = String(hoje.getDate()).padStart(2, '0');
      document.getElementById('hist-date').value = y + '-' + m + '-' + d;
      renderHist();
    }
    
    function limparFiltro() {
      document.getElementById('hist-date').value = '';
      renderHist();
    }

    function renderHist() {
      if(!historicoGlobal) return;
      const dateFilter = document.getElementById('hist-date').value; // YYYY-MM-DD
      
      let filt = historicoGlobal;
      if (dateFilter) {
        filt = historicoGlobal.filter(t => {
          const dStr = new Date(t.time).toISOString().split('T')[0];
          return dStr === dateFilter;
        });
      }
      
      let totPnl = 0, totFee = 0;
      filt.forEach(t => {
        if(t.type === 'REALIZED_PNL') totPnl += t.val;
        if(t.type === 'COMMISSION' || t.type === 'FUNDING_FEE') totFee += t.val;
      });
      
      const liq = totPnl + totFee;
      
      document.getElementById('dh-bruto').innerText = fmtDolar(totPnl);
      document.getElementById('dh-bruto-brl').innerText = fmtBrl(totPnl * brlGlobal);
      document.getElementById('dh-bruto-brl').style.color = '#3b82f6';
      document.getElementById('dh-bruto').style.color = totPnl >= 0 ? 'var(--green)' : 'var(--red)';
      
      document.getElementById('dh-taxas').innerText = fmtDolar(Math.abs(totFee));
      document.getElementById('dh-taxas-brl').innerText = fmtBrl(Math.abs(totFee) * brlGlobal);
      document.getElementById('dh-taxas-brl').style.color = '#3b82f6';
      
      document.getElementById('dh-liq').innerText = fmtDolar(liq);
      document.getElementById('dh-liq-brl').innerText = fmtBrl(liq * brlGlobal);
      document.getElementById('dh-liq-brl').style.color = '#3b82f6';
      document.getElementById('dh-liq').style.color = liq >= 0 ? 'var(--gold)' : 'var(--red)';
      
      const box = document.getElementById('hist-content');
      if (filt.length === 0) {
        box.innerHTML = '<div style="padding:20px; text-align:center;">Nenhum registro encontrado.</div>';
        return;
      }
      
      let html = '<table style="width:100%; text-align:left; border-collapse:collapse;">';
      html += '<tr style="border-bottom:1px solid var(--border); color:var(--gold);"><th style="padding:8px 0;">Hora</th><th style="padding:8px 0;">Ativo</th><th style="padding:8px 0;">Operação</th><th style="padding:8px 15px 8px 0; text-align:right;">Valor (PnL)</th></tr>';
      
      // Grouping logic for commissions and trades
      let groups = [];
      filt.forEach(t => {
         let placed = false;
         for (let g of groups) {
            if (g.symbol === t.symbol && Math.abs(g.time - t.time) < 60000) {
               if (t.type === 'REALIZED_PNL') {
                  g.pnl += t.val;
                  g.hasPnl = true;
               } else if (t.type === 'COMMISSION' || t.type === 'FUNDING_FEE') {
                  g.fee += t.val;
               }
               placed = true;
               break;
            }
         }
         if (!placed) {
            groups.push({
               time: t.time,
               symbol: t.symbol,
               pnl: t.type === 'REALIZED_PNL' ? t.val : 0,
               fee: (t.type === 'COMMISSION' || t.type === 'FUNDING_FEE') ? t.val : 0,
               hasPnl: t.type === 'REALIZED_PNL'
            });
         }
      });
      
      for(const g of groups) {
        const timeStr = new Date(g.time).toLocaleString();
        let tipo = "";
        let badge = "";
        let totalVal = g.pnl + g.fee;
        
        if (g.hasPnl) {
           const meta = metadataGlobal[g.symbol];
           let sideTxt = "";
           let sideBadge = "";
           let alavTxt = "";

           if (meta) {
             const isLong = meta.side === 'LONG';
             sideTxt = isLong ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
             const bgCol = isLong ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
             const txtCol = isLong ? 'var(--green)' : 'var(--red)';
             sideBadge = '<span style="font-size:0.6rem; background:' + bgCol + '; color:' + txtCol + '; padding:2px 5px; border-radius:4px; margin-left:4px; font-weight:bold;">' + sideTxt + '</span>';
             if (meta.leverage) {
               alavTxt = '<span style="font-size:0.6rem; background:rgba(212,175,55,0.2); color:var(--gold); padding:2px 5px; border-radius:4px; margin-left:4px; font-weight:bold;">' + meta.leverage + 'x</span>';
             }
           }

           tipo = "Trade";
           if (g.pnl > 0) badge = "<span style='font-size:0.6rem; background:rgba(34,197,94,0.2); color:var(--green); padding:2px 4px; border-radius:4px; margin-left:4px;'>TP</span>";
           else badge = "<span style='font-size:0.6rem; background:rgba(239,68,68,0.2); color:var(--red); padding:2px 4px; border-radius:4px; margin-left:4px;'>SL</span>";
           badge += sideBadge + alavTxt;
        } else {
           tipo = "Taxa/Entr.";
        }
        
        let corPnl = g.pnl >= 0 ? 'var(--green)' : 'var(--red)';
        if (!g.hasPnl) corPnl = 'var(--text-muted)';
        
        html += \`<tr style="border-bottom:1px dashed rgba(255,255,255,0.1);">
          <td style="padding:10px 0; color:var(--text-muted); font-size:0.8rem;">\${timeStr}</td>
          <td style="padding:10px 0; font-weight:500;">\${g.symbol}</td>
          <td style="padding:10px 0; font-size:0.85rem;">\${tipo}\${badge}
             <div style="font-size:0.65rem; color:var(--text-muted); margin-top:2px;">Liq: \${fmtDolar(totalVal)} (Taxa: \${fmtDolar(g.fee)})</div>
          </td>
          <td style="padding:10px 15px 10px 0; text-align:right; color:\${corPnl}; font-weight:bold;">\${fmtDolar(g.pnl)}<br><span style="font-size:0.65rem; color:#3b82f6;">(\${fmtBrl(g.pnl * brlGlobal)})</span></td>
        </tr>\`;
      }
      html += '</table>';
      box.innerHTML = html;
    }

    function renderAgrupado(tipo) {
      if(!historicoGlobal) return;
      const grupos = {};
      
      historicoGlobal.forEach(t => {
         const dObj = new Date(t.time);
         const y = dObj.getFullYear();
         const m = String(dObj.getMonth() + 1).padStart(2, '0');
         const d = String(dObj.getDate()).padStart(2, '0');
         
         let chave = '';
         if (tipo === 'dia') {
             chave = y + '-' + m + '-' + d;
         } else if (tipo === 'mes') {
             chave = y + '-' + m;
         } else if (tipo === 'semana') {
             const dClone = new Date(t.time);
             const day = dClone.getDay();
             const diff = dClone.getDate() - day + (day === 0 ? -6 : 1);
             const monday = new Date(dClone.setDate(diff));
             const my = monday.getFullYear();
             const mm = String(monday.getMonth() + 1).padStart(2, '0');
             const md = String(monday.getDate()).padStart(2, '0');
             chave = my + '-' + mm + '-' + md + ' (Sem.)';
         }
         
         if (!grupos[chave]) grupos[chave] = { pnl: 0, fee: 0 };
         if (t.type === 'REALIZED_PNL') grupos[chave].pnl += t.val;
         if (t.type === 'COMMISSION' || t.type === 'FUNDING_FEE') grupos[chave].fee += t.val;
      });
      
      let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
      const keys = Object.keys(grupos).sort().reverse();
      
      keys.forEach(k => {
         const g = grupos[k];
         const liq = g.pnl + g.fee;
         const cor = liq >= 0 ? 'var(--green)' : 'var(--red)';
         const sinal = liq >= 0 ? '+' : '';
         const brl = liq * brlGlobal;
         
         let pctTxt = '';
         if (saldoGlobal > 0) {
            const pct = (liq / saldoGlobal) * 100;
            pctTxt = ' <span style="font-size:0.8rem; font-weight:normal; opacity:0.8;">(' + sinal + pct.toFixed(2) + '%)</span>';
         }
         
         let label = k;
         if (tipo === 'dia') {
            const parts = k.split('-');
            label = parts[2] + '/' + parts[1] + '/' + parts[0];
         } else if (tipo === 'mes') {
            const parts = k.split('-');
            label = parts[1] + '/' + parts[0];
         }
         
         html += '<div style="background:rgba(0,0,0,0.3); padding:12px 15px; border-radius:8px; border:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">';
         html += '<div style="font-weight:bold; color:var(--text); font-size:0.9rem;">' + label + '</div>';
         html += '<div style="text-align:right; color:' + cor + '; font-weight:bold; font-size:1rem;">';
         html += sinal + fmtDolar(Math.abs(liq)) + pctTxt + '<br>';
         html += '<span style="font-size:0.75rem; color:#3b82f6;">' + sinal + fmtBrl(Math.abs(brl)) + '</span>';
         html += '</div></div>';
      });
      
      if (keys.length === 0) html += '<div style="padding:20px; text-align:center;">Nenhum registro.</div>';
      html += '</div>';
      
      document.getElementById('hist-content').innerHTML = html;
    }
    
    function fecharHistorico() {
      document.getElementById('modal-hist').style.display = 'none';
    }

    async function atualizarGauge(col) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if(!sym) return;
      if(!sym.endsWith('USDT')) sym += 'USDT';
      try {
        const r = await fetch('/api/gauge/'+sym);
        const d = await r.json();
        if(d.success) {
          document.getElementById('gl-'+col).innerText = d.longPct + '%';
          document.getElementById('gs-'+col).innerText = d.shortPct + '%';
          
          if(d.bidAskBase !== undefined) {
             document.getElementById('gauge-book-'+col).innerText = d.bidAskBase + '%';
             
             let fundColor = '#FFF';
             if (d.fundingRate > 0.00015) fundColor = '#EF4444'; // alto risco short
             else if (d.fundingRate < 0.00005) fundColor = '#10B981'; // alto risco long
             const fundEl = document.getElementById('gauge-fund-'+col);
             fundEl.innerText = (d.fundingRate * 100).toFixed(4) + '%';
             fundEl.style.color = fundColor;

             let oiTxt = '--';
             if (d.openInterest > 0) {
               if (d.openInterest >= 1000000) oiTxt = (d.openInterest / 1000000).toFixed(1) + 'M';
               else if (d.openInterest >= 1000) oiTxt = (d.openInterest / 1000).toFixed(1) + 'K';
               else oiTxt = d.openInterest.toFixed(0);
             }
             document.getElementById('gauge-oi-'+col).innerText = oiTxt;
          }
        }
      } catch(e) {}
    }

    async function atualizarIA(col) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if(!sym) return;
      if(!sym.endsWith('USDT')) sym += 'USDT';
      try {
        const res = await fetch('/api/ia-analysis/'+sym);
        const data = await res.json();
        if(data.success && data.recomendacao) {
          iaRecommendation[col] = data.recomendacao;
        }
      } catch(e) {}
    }

    function debouncedLoad(col) {
      clearTimeout(timers[col]);
      clearInterval(autoRefresh[col]);
      clearInterval(iaTimers[col]);
      iaRecommendation[col] = '';
      document.getElementById('status-'+col).innerText = "Buscando...";
      document.getElementById('status-'+col).style.color = "var(--gold)";
      document.getElementById('pos-'+col).style.display = 'none';
      timers[col] = setTimeout(() => {
        loadData(col);
        atualizarGauge(col);
        atualizarIA(col);
        autoRefresh[col] = setInterval(() => {
           loadData(col);
           atualizarGauge(col);
        }, 5000);
        iaTimers[col] = setInterval(() => {
           atualizarIA(col);
        }, 45000); // 45s poll para a IA da 9router
      }, 800);
    }
    
    async function loadData(col) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if(!sym) return;
      if(!sym.endsWith('USDT')) sym += 'USDT';
      localStorage.setItem('sym-'+col, sym);
      
      try {
        const res = await fetch('/api/moeda/'+sym);
        const data = await res.json();
        
        if(!data.success) {
          document.getElementById('status-'+col).innerText = data.error || "Erro";
          document.getElementById('status-'+col).style.color = "var(--red)";
          return;
        }
        
        document.getElementById('status-'+col).innerText = "Sincronizado";
        document.getElementById('status-'+col).style.color = "var(--green)";
        document.getElementById('price-'+col).innerText = "$ " + parseFloat(data.preco).toFixed(4);

        // Carrega mini-gráfico de velas 1m + SAR (não bloqueia o resto da UI)
        renderCandles1m(col, sym);
        
        const therm = document.getElementById('therm-'+col);
        therm.style.width = data.score + "%";
        if(data.score > 55) therm.style.background = "var(--green)";
        else if(data.score < 45) therm.style.background = "var(--red)";
        else therm.style.background = "var(--blue)";
        
        ['1d','12h','6h','3h','1h','15m','1m'].forEach(tf => {
           const dot = document.getElementById('dot-'+col+'-'+tf);
           dot.className = "dot " + (data.intervals[tf] || "");
        });
        
        document.getElementById('rsi-'+col).innerText = data.rsi || '--';
        document.getElementById('trend-'+col).innerText = data.trend || 'NEUTRA';
        document.getElementById('trend-'+col).style.color = data.trendColor || 'gray';
        
        const posBox = document.getElementById('pos-'+col);
        if (data.pos) {
          posBox.style.display = 'block';
          
          // Se abriu posição, desliga a tarja de auxílio de IA (para não poluir e economizar requisições)
          toggleAdvise(col, false);

          const p = data.pos;
          const ladoEl = document.getElementById('pos-lado-'+col);
          ladoEl.innerText = p.lado + " " + p.alavancagem + "x";
          ladoEl.className = p.lado === 'LONG' ? 'text-green' : 'text-red';
          document.getElementById('pos-qty-'+col).innerText = "Qty: " + p.quantidade;
          
          const pnlEl = document.getElementById('pos-pnl-'+col);
          const pnl = p.pnlNaoRealizado;
          const margem = p.margem || ((p.quantidade * p.precoEntrada) / p.alavancagem);
          let roi = 0;
          if (margem > 0) roi = (pnl / margem) * 100;
          const sinal = pnl >= 0 ? '+' : '';
          let alertaHtml = (pnl > 0 && iaRecommendation[col] === 'SAIR') ? \`<div class="alerta-lucro">⚠️ IA: SAIA AGORA OU PERCA LUCRO</div>\` : '';
          pnlEl.innerHTML = (pnl >= 0 ? "+$ " : "-$ ") + Math.abs(pnl).toFixed(2) + \` (\${sinal}\${roi.toFixed(2)}%)\` + alertaHtml;
          pnlEl.className = "pos-pnl " + (pnl >= 0 ? 'text-green' : 'text-red');
          
          document.getElementById('pos-pnl-brl-'+col).innerText = fmtBrl(Math.abs(pnl * brlGlobal));
          document.getElementById('pos-pnl-brl-'+col).style.color = '#3b82f6';
          
          document.getElementById('pos-entry-'+col).innerText = p.precoEntrada.toFixed(4);
        } else {
          posBox.style.display = 'none';
        }
      } catch (e) {
        document.getElementById('status-'+col).innerText = "Falha de rede";
      }
    }

    // ── Mini-gráfico de Velas 1m + Parabolic SAR ──────────────────────────
    async function renderCandles1m(col, sym) {
      try {
        const res = await fetch('/api/candles1m/' + sym);
        const d = await res.json();
        if (!d.success || !d.candles || d.candles.length === 0) return;

        const candles = d.candles;
        const svg = document.getElementById('velas-svg-' + col);
        const pctRow = document.getElementById('velas-pct-' + col);
        if (!svg || !pctRow) return;

        // Dimensões do viewBox
        const W = 220, H = 68;
        const N = candles.length;
        const slotW = W / N;       // largura por vela
        const bodyW = Math.max(3, slotW * 0.55); // largura do corpo
        const gap   = (slotW - bodyW) / 2;

        // Escala de preço: usa high/low de toda a série
        const allH = candles.map(c => c.high);
        const allL = candles.map(c => c.low);
        const allPsar = candles.map(c => c.psar).filter(v => v !== null);
        const priceMax = Math.max(...allH, ...allPsar);
        const priceMin = Math.min(...allL, ...allPsar);
        const priceRange = priceMax - priceMin || 1;

        const toY = price => H - ((price - priceMin) / priceRange) * H;

        // Área reservada para setas SAR (acima/abaixo da vela)
        const PAD_TOP = 10, PAD_BOT = 10;
        const chartH = H - PAD_TOP - PAD_BOT;
        const toYchart = price => PAD_TOP + chartH - ((price - priceMin) / priceRange) * chartH;

        let html = '';

        candles.forEach((c, i) => {
          const x = i * slotW;
          const cx = x + slotW / 2;
          const color = c.green ? '#10B981' : '#EF4444';

          const yOpen  = toYchart(c.open);
          const yClose = toYchart(c.close);
          const yHigh  = toYchart(c.high);
          const yLow   = toYchart(c.low);

          const bodyTop    = Math.min(yOpen, yClose);
          const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

          // Pavio
          html += \`<line x1="\${cx}" y1="\${yHigh}" x2="\${cx}" y2="\${yLow}" stroke="\${color}" stroke-width="1" opacity="0.7"/>\`;
          // Corpo
          html += \`<rect x="\${cx - bodyW/2}" y="\${bodyTop}" width="\${bodyW}" height="\${bodyHeight}" fill="\${color}" rx="1"/>\`;

          // Seta do SAR
          if (c.psar !== null && c.sarAcima !== null) {
            const sarY = toYchart(c.psar);
            if (c.sarAcima) {
              // SAR está acima -> tendência de baixa -> seta pra baixo em cima da vela
              const ay = Math.min(bodyTop, yHigh) - 5;
              html += \`<text x="\${cx}" y="\${ay}" text-anchor="middle" font-size="7" fill="#EF4444">▼</text>\`;
            } else {
              // SAR está abaixo -> tendência de alta -> seta pra cima embaixo da vela
              const ay = Math.max(Math.max(yOpen, yClose), yLow) + 8;
              html += \`<text x="\${cx}" y="\${ay}" text-anchor="middle" font-size="7" fill="#10B981">▲</text>\`;
            }
          }
        });

        svg.innerHTML = html;

        // Linha de % abaixo de cada vela
        pctRow.innerHTML = candles.map(c => {
          const cls = c.green ? 'up' : 'dn';
          const label = (c.green ? '+' : '') + c.pct.toFixed(1) + '%';
          return \`<span class="vela-pct \${cls}">\${label}</span>\`;
        }).join('');

      } catch(e) {
        // Falha silenciosa — o resto do card continua funcionando
      }
    }
    
    async function execTrade(col, lado) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      const val = document.getElementById('val-'+col).value.trim();
      const alav = document.getElementById('alav-'+col).value;
      
      if(!sym) { askConfirm("Atenção", "Moeda vazia", true); return; }
      if(!sym.endsWith('USDT')) sym += 'USDT';
      if(!val || val <= 0) { askConfirm("Atenção", "Valor inválido", true); return; }
      
      const corLado = lado === 'BUY' ? 'var(--green)' : 'var(--red)';
      const txtLado = lado === 'BUY' ? 'LONG' : 'SHORT';
      const html = \`
        <div style="font-size:1.1rem; margin-bottom:10px;">Par: <b style="color:var(--text);">\${sym}</b></div>
        <div style="font-size:1.1rem; margin-bottom:10px;">Ordem: <b style="color:\${corLado};">\${txtLado}</b></div>
        <div style="font-size:1.1rem; margin-bottom:10px;">Alavancagem: <b style="color:var(--text);">\${alav}x</b></div>
        <div style="font-size:1.1rem; margin-bottom:20px;">Tamanho Total: <b style="color:var(--text);">\${val} USDT</b></div>
      \`;
      
      if (!(await askConfirm('Executar Ordem', html))) return;
      
      const st = document.getElementById('status-'+col);
      st.innerText = "Executando...";
      st.style.color = "var(--gold)";
      
      try {
        const res = await fetch('/api/trade', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym, lado, valorUSDT: val, alavancagem: alav })
        });
        const data = await res.json();
        
        if(data.success) {
          st.innerText = data.warning ? "Parcial!" : "Executado!";
          st.style.color = "var(--green)";
          if(data.warning) askConfirm("Aviso", data.warning, true);
          loadData(col);
          carregarSaldo();
        } else {
          st.innerText = "Falha!";
          st.style.color = "var(--red)";
          askConfirm("Erro ao Comprar", data.error, true);
        }
      } catch (e) {
        st.innerText = "Erro";
        st.style.color = "var(--red)";
      }
    }
    
    async function fecharPosicao(col) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if(!sym.endsWith('USDT')) sym += 'USDT';
      
      const html = \`<div style="font-size:1.1rem; color:var(--text); margin-bottom:20px;">Deseja encerrar 100% da posição de <b style='color:var(--gold);'>\${sym}</b> a preço de mercado?</div>\`;
      if(!(await askConfirm('Fechar Posição', html))) return;
      
      const st = document.getElementById('status-'+col);
      st.innerText = "Fechando...";
      
      try {
        const res = await fetch('/api/close', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym })
        });
        const data = await res.json();
        
        if(data.success) {
          st.innerText = "Encerrada!";
          st.style.color = "var(--green)";
          loadData(col);
          carregarSaldo();
        } else {
          st.innerText = "Erro: " + data.error;
          st.style.color = "var(--red)";
        }
      } catch (e) {
        st.innerText = "Erro";
      }
    }

    async function aplicarTPSL(col) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if(!sym.endsWith('USDT')) sym += 'USDT';
      
      const tp = document.getElementById('tp-'+col).value;
      const sl = document.getElementById('sl-'+col).value;
      
      const st = document.getElementById('status-'+col);
      st.innerText = "Aplicando alvos...";
      
      try {
        const res = await fetch('/api/tp-sl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym, tpPct: tp, slPct: sl })
        });
        const data = await res.json();
        if(data.success) {
          st.innerText = "Alvos (TP/SL) armados!";
          st.style.color = "var(--green)";
          askConfirm("✓ Sucesso", "Monitoramento local de TP/SL ativado para <b style='color:var(--gold);'>" + sym + "</b>.", true);
          loadData(col);
        } else {
          st.innerText = "Erro: " + data.error;
          st.style.color = "var(--red)";
          askConfirm("❌ Erro", "Erro ao aplicar: " + data.error, true);
        }
      } catch(e) {
        st.innerText = "Erro de rede";
      }
    }

    async function reverterPosicao(col) {
      let sym = document.getElementById('sym-'+col).value.trim().toUpperCase();
      if(!sym.endsWith('USDT')) sym += 'USDT';

      const html = \`<div style="font-size:1.1rem; color:var(--text); margin-bottom:20px;">Deseja <b style='color:var(--gold);'>REVERTER</b> a posição atual de \${sym}? O sistema vai fechar a mercado e abrir do lado oposto com a mesma quantidade.</div>\`;
      if(!(await askConfirm('Reverter Posição', html))) return;

      const st = document.getElementById('status-'+col);
      st.innerText = "Revertendo...";

      try {
        const res = await fetch('/api/reverse', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym })
        });
        const data = await res.json();
        if(data.success) {
          st.innerText = "Posição revertida!";
          st.style.color = "var(--green)";
          loadData(col);
          carregarSaldo();
        } else {
          st.innerText = "Erro: " + data.error;
          st.style.color = "var(--red)";
        }
      } catch (e) {
        st.innerText = "Erro de rede";
      }
    }

    async function carregarVolateis() {
      try {
        const r = await fetch('/api/volateis');
        const d = await r.json();
        if(!d.success) return;
        let html = '';
        for (const t of d.top) {
          const cor = t.pct >= 0 ? 'var(--green)' : 'var(--red)';
          const sinal = t.pct > 0 ? '+' : '';
          html += \`<div class="vol-item" onclick="setCoinFromBar('\${t.symbol}')">
            <span class="sym">\${t.symbol}</span>
            <span class="pct" style="color:\${cor}">\${sinal}\${t.pct}%</span>
          </div>\`;
        }
        document.getElementById('vol-bar').innerHTML = html;
      } catch(e) {}
    }

    function selecionarColuna(col) {
      colAtiva = col;
      document.getElementById('card-1').classList.remove('active');
      document.getElementById('card-2').classList.remove('active');
      document.getElementById('card-'+col).classList.add('active');
    }

    function setCoinFromBar(symbol) {
      const pos = document.getElementById('pos-'+colAtiva).style.display === 'block';
      if (pos) {
        askConfirm('Atenção', 'A coluna selecionada possui uma ordem ativa. Feche a operação ou selecione o outro quadro de moeda primeiro.', true);
        return;
      }
      aplicarMoeda(colAtiva, symbol);
    }

    function aplicarMoeda(col, symbol) {
      document.getElementById('sym-'+col).value = symbol;
      debouncedLoad(col);
    }

    // Gerenciador do Robô Autônomo e Placar
    let autoBotActive = false;

    async function carregarPlacar() {
      try {
        const r = await fetch('/api/win-loss');
        const d = await r.json();
        if (d.success) {
          document.getElementById('placar-wins').innerText = d.wins + ' W';
          document.getElementById('placar-losses').innerText = d.losses + ' L';
          const dwEl = document.getElementById('dobradinha-wins');
          const dlEl = document.getElementById('dobradinha-losses');
          if (dwEl) dwEl.innerText = (d.winDobradinha || 0) + ' 2W';
          if (dlEl) dlEl.innerText = (d.lossDobradinha || 0) + ' 2L';
        }
      } catch(e) {}
    }

    async function zerarPlacar() {
      if (!(await askConfirm('Zerar Placar', 'Deseja reiniciar a contagem de acertos, erros e dobradinha a partir deste momento?'))) return;
      try {
        const r = await fetch('/api/limpar-placar', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          carregarPlacar();
          askConfirm('✓ Sucesso', 'Placar zerado com sucesso.', true);
        }
      } catch(e) {}
    }

    async function atualizarStatusAutoBot() {
      try {
        const r = await fetch('/api/auto-status');
        const d = await r.json();
        if (d.success) {
          autoBotActive = d.enabled;
          const btn = document.getElementById('btn-auto-toggle');
          const statusTxt = document.getElementById('auto-status-text');
          const timerEl = document.getElementById('auto-timer');
          const logEl = document.getElementById('auto-log-text');

          if (d.enabled) {
            btn.innerText = 'DESLIGAR ROBÔ';
            btn.style.background = 'rgba(239, 68, 68, 0.2)';
            btn.style.borderColor = 'var(--red)';
            btn.style.color = 'var(--red)';
            statusTxt.innerText = '● Robô Autônomo Ativo';
            statusTxt.style.color = 'var(--green)';

            if (timerEl) timerEl.innerText = 'CONTÍNUO';

            // Reflete as moedas nos inputs das colunas se o robô tiver alocado
            [1, 2].forEach(col => {
              const sl = d.slots[col];
              if (sl) {
                const symTarget = sl.symbol || sl.targetSymbol;
                if (symTarget) {
                  const symInput = document.getElementById('sym-' + col);
                  const cur = symInput.value.trim().toUpperCase();
                  if (cur !== symTarget) {
                    symInput.value = symTarget;
                    debouncedLoad(col);
                  }
                }
                if (sl.leverage) {
                  const alavEl = document.getElementById('alav-' + col);
                  const alavVal = document.getElementById('alav-val-' + col);
                  if (alavEl && alavEl.value != sl.leverage) {
                    alavEl.value = sl.leverage;
                    if (alavVal) alavVal.innerText = sl.leverage + 'x';
                  }
                }
                const valEl = document.getElementById('val-' + col);
                if (valEl && (!valEl.value || valEl.value != 10)) {
                  valEl.value = 10;
                }
                const st = document.getElementById('status-' + col);
                if (st && sl.status) {
                  st.innerText = '🤖 ' + sl.status;
                  st.style.color = sl.status.startsWith('ATIVO') ? 'var(--green)' : 'var(--gold)';
                }
              }
            });
          } else {
            btn.innerText = 'LIGAR ROBÔ IA';
            btn.style.background = 'rgba(16, 185, 129, 0.2)';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            statusTxt.innerText = 'Robô Desligado';
            statusTxt.style.color = 'var(--text-muted)';
            timerEl.innerText = 'OFF';
          }

          if (d.lastLog) logEl.innerText = d.lastLog;
          const tokEl = document.getElementById('total-tokens-val');
          if (tokEl && d.tokensGastos !== undefined) {
            tokEl.innerText = Number(d.tokensGastos).toLocaleString('pt-BR');
          }
          carregarRagBadge();
        }
      } catch(e) {}
    }

    let ultimoCarregamentoRag = 0;
    async function carregarRagBadge() {
      const agora = Date.now();
      if (agora - ultimoCarregamentoRag < 10000) return; // cache 10s
      ultimoCarregamentoRag = agora;
      try {
        const r = await fetch('/api/rag-stats');
        const d = await r.json();
        if (d.success && d.stats) {
          const el = document.getElementById('auto-rag-badge');
          if (el) {
            const tot = d.stats.total || 0;
            const wins = d.stats.wins || 0;
            const wr = tot > 0 ? Math.round((wins / tot) * 100) : 0;
            el.innerText = tot + ' trades (' + wr + '% win)';
          }
        }
      } catch(e) {}
    }

    async function toggleAutoBot() {
      const novoEstado = !autoBotActive;
      const acao = novoEstado ? 'LIGAR' : 'DESLIGAR';
      if (!(await askConfirm(acao + ' ROBÔ', 'Deseja ' + acao.toLowerCase() + ' o robô autônomo com IA (ciclos de 10 minutos, $10 fixos, reversão via SAR)?'))) return;

      try {
        const r = await fetch('/api/auto-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: novoEstado })
        });
        const d = await r.json();
        if (d.success) {
          atualizarStatusAutoBot();
        }
      } catch(e) {
        askConfirm('Erro', 'Falha ao alterar estado do robô.', true);
      }
    }

    // Inicialização segura
    window.addEventListener('DOMContentLoaded', () => {
      [1, 2].forEach(col => {
        const saved = localStorage.getItem('sym-'+col);
        if(saved && saved !== 'undefined' && saved !== 'null') {
          document.getElementById('sym-'+col).value = saved;
          debouncedLoad(col);
        } else {
          document.getElementById('sym-'+col).value = '';
        }
      });
      carregarSaldo();
      carregarVolateis();
      carregarPlacar();
      atualizarStatusAutoBot();
      setInterval(carregarSaldo, 3600000); // 1 hora
      setInterval(carregarVolateis, 60000); // 1 min
      setInterval(carregarPlacar, 10000); // 10s
      setInterval(atualizarStatusAutoBot, 3000); // 3s
    });
  </script>
</body>
</html>`);
});

(async () => {
  try {
    await fut.sincronizarRelogio('boot');
    await fut.carregarExchangeInfo();
    app.listen(PORT, () => console.log('Painel escutando na porta ' + PORT));
  } catch (e) {
    console.error("Erro no boot:", e);
  }
})();