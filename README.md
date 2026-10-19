# 🤖 Crypto Futuros — Robô Autônomo & Dashboard para Binance Futures

Robô quantitativo autônomo e painel de controle em tempo real para **Binance Futures USDⓈ-M**, equipado com **Memória RAG em SQLite**, **Gamificação de Indicadores Técnicos (0 Tokens)**, **Detecção de Armadilhas de Smart Money** e **IA Estrategista**.

---

## ⚡ Principais Funcionalidades

### 1. Operação Contínua 24/7 (2 Slots Independentes)
- Dois operários autônomos que operam de forma 100% desacoplada e ininterrupta.
- **Anti-Conflito:** O Slot 1 e o Slot 2 nunca operam a mesma moeda simultaneamente.
- **Fluxo Contínuo:** Assim que uma posição é encerrada (por TP, Trailing, Breakeven ou SL), o slot grava a lição no RAG e pesquisa imediatamente a próxima melhor oportunidade no mercado.
- **Descarte de Moedas Travadas:** Se uma moeda escolhida ficar mais de 8 minutos sem disparar o gatilho técnico, o slot a descarta automaticamente e busca um novo par com momentum ativo.

### 2. Memória RAG Contínua em SQLite (`trades_rag`)
- **Snapshot de Entrada:** Grava no milissegundo da abertura todos os dados técnicos: RSI 15m/1m, médias EMA 9/21, Parabolic SAR, Volume Ratio, Funding Rate, Order Book Ratio, níveis de Fibonacci e padrões de velas.
- **Feedback & Post-Mortem na Saída:** Registra o desfecho (`WIN`, `LOSS`, `BREAKEVEN`), ROI %, PnL USDT e diagnóstico da causa de vitória ou derrota.
- **Porteiro RAG Antes do Trade:** Consulta o banco histórico antes de executar. Se o setup ou par acumular histórico recente de derrotas (ex: 3 losses seguidos), o RAG emite **VETO IMEDIATO**, impedindo o robô de repetir o mesmo erro.

### 3. Gamificação dos Indicadores Técnicos (Custo 0 Tokens, < 5ms)
- O loop de monitoramento local calcula um placar de 0 a 100 pontos em tempo real sem gastar tokens:
  - **Médias Rápidas EMA 9 vs 21 (1m):** ±20 pts
  - **Parabolic SAR (1m):** ±20 pts
  - **Volume Ratio (vs média 20 períodos):** até ±20 pts
  - **RSI 15m (margem de expansão vs exaustão):** até ±25 pts
  - **Livro de Ofertas (profundidade compradora vs vendedora):** até ±15 pts
  - **Padrões de Candlestick (Engolfo, Martelo, Doji):** até ±20 pts

### 4. Detecção de Armadilhas (Smart Money / Contrarian)
- Quando o varejo aponta compra eufórica (Score > 70 pts), mas o Funding Rate está caro (> 0.02%) em topo de swing:
  - O sistema detecta `ARMADILHA_CONTRARIA`.
  - Inverte o gatilho para **SELL (SHORT)**.
  - Aplica **cautela de multiplicação**: reduz alavancagem para proteção de capital.

### 5. Camada Inteligente de Segurança do Lucro (>= +2.0% ROI)
- Quando o lucro da operação atinge **>= +2.0% ROI**, a IA é consultada a cada 15 segundos.
- A IA avalia o fluxo e decide entre `CONTINUAR` (para surfar a tendência) ou `FECHAR` (para embolsar o lucro imediatamente antes de qualquer reversão).
- **Sem cortes precoces em perda:** Em operações negativas, a IA não interfere, permitindo que o trade oscile livremente até repicar para o lucro ou bater o Stop Loss oficial (-10%).

### 6. Breakeven Automático no 0 a 0 (+2.5% -> +0.4%)
- Ao atingir pelo menos **+2.5% de ROI**, o stop de proteção é movido para **+0.4% de ROI**.
- Se o mercado reverter bruscamente, a ordem é fechada no zero a zero, cobrindo integralmente as taxas de corretagem da Binance sem qualquer prejuízo líquido.

### 7. Alavancagem Rigorosa (Teto 5x)
- **Teto Máximo:** 5x em todo o sistema.
- **Faixa Normal:** 2x a 5x.
- **Uso de 1x:** Estritamente reservado para casos extremos de volatilidade ou ruído anormal de mercado.

### 8. Dashboard Web Mobile-First Luxury Dark Mode (Porta 7005)
- Interface escura de alta fidelidade com glassmorphism, detalhes em Ouro (`#D4AF37`) e Azul Royal (`#1D4ED8`).
- Minigráficos em SVG dinâmico (velas de 1m + Parabolic SAR).
- Contador de tokens gastos em tempo real integrado ao cabeçalho.
- Placar W/L e histórico com cálculo de ROI e conversão para Reais (BRL).

---

## 🛠️ Tecnologias Utilizadas

- **Node.js** (v18+)
- **Express.js** & **WebSocket (`ws`)**
- **SQLite3** (Modo WAL com pragmas de alta concorrência)
- **Axios** (Conexão REST com Binance Futures e 9Router/OpenAI)
- **TechnicalIndicators** (Cálculo quantitativo de EMAs, SAR, RSI, ATR e Fibonacci)

---

## 📋 Pré-requisitos

1. Conta na Binance com Futuros habilitados e chaves de API (`API Key` e `API Secret`).
2. Endpoint de IA compatível com OpenAI (ex: **9Router**, OpenAI API, ou provedor local).
3. Servidor Linux (VPS) ou máquina local com **Node.js** e **PM2** instalados.

---

## 🚀 Instalação e Configuração

### 1. Clonar o repositório
```bash
git clone https://github.com/rigaxx/crypto-futuros.git
cd crypto-futuros
```

### 2. Instalar dependências
```bash
npm install
```

### 3. Configurar Variáveis de Ambiente
Copie o arquivo de exemplo e preencha suas credenciais:
```bash
cp .env.example .env
nano .env
```

Preencha as variáveis no arquivo `.env`:
```ini
# Chaves da Binance
BINANCE_API_KEY=sua_api_key_aqui
BINANCE_SECRET=sua_secret_aqui

# Endpoints Binance (Produção)
FUTURES_BASE=https://fapi.binance.com
FUTURES_WS=wss://fstream.binance.com

# Endpoint de IA (9Router ou OpenAI)
ROUTER_API_KEY=seu_token_de_ia_aqui

# Porta e Senha de Acesso ao Painel
PORT=7005
ACESSO_SENHA=sua_senha_segura
```

---

## ▶️ Execução

### Modo Desenvolvimento / Teste Direto:
```bash
node painel_futuros.js
```

### Modo Produção com PM2 (Recomendado):
```bash
pm2 start painel_futuros.js --name "painel-crypto"
pm2 save
```

Para monitorar os logs em tempo real:
```bash
pm2 logs painel-crypto
```

---

## 🌐 Acesso ao Painel Web

Abra no navegador:
```text
http://SEU_IP_OU_DOMINIO:7005
```
- **Login:** qualquer usuário.
- **Senha:** a configurada em `ACESSO_SENHA` no seu `.env` (padrão: `admin123`).

No topo do painel, clique em **LIGAR ROBÔ IA** para ativar o motor autônomo contínuo.

---

## 📁 Estrutura do Projeto

```text
├── db.js                           # Camada de conexão e queries SQLite
├── package.json                    # Dependências e scripts do projeto
├── painel_futuros.js               # Servidor Express, Web UI, loop contínuo e gatilhos
├── .env.example                    # Modelo de configuração de ambiente
├── .gitignore                      # Proteção de credenciais e bancos de dados
├── lib/
│   ├── futuresApi.js               # Conector assinado da API Binance Futures USDⓈ-M
│   ├── rag_memory.js               # Memória de aprendizado contínuo (RAG SQLite)
│   └── sincronizarHistoricoFuturos.js # Sincronização de trades e histórico
└── README.md                       # Documentação do projeto
```

---

## ⚠️ Aviso Legal (Disclaimer)

O mercado de futuros de criptomoedas envolve risco financeiro significativo. Este software é fornecido exclusivamente para fins educacionais e de estudo quantitativo. Os desenvolvedores e mantenedores não se responsabilizam por quaisquer perdas financeiras resultantes do uso deste sistema. Opere com responsabilidade e utilize margem controlada.
