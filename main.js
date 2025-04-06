require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { RSI, SMA, MACD, BollingerBands, EMA, ATR } = require('technicalindicators');
const WebSocket = require('ws');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Inisialisasi cryptoMapping
let cryptoMapping = {};
try {
  cryptoMapping = JSON.parse(fs.readFileSync('cryptoMapping.json', 'utf8'));
} catch (err) {
  console.error('Error loading crypto mapping:', err);
}

// Cache dengan TTL dan LRU
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (item) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return item.data;
    }
  }

  set(key, data) {
    if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

const candleCache = new LRUCache(1000);
const sentimentCache = new LRUCache(1000);
const CACHE_TTL = 60 * 60 * 1000; // 1 jam

// WebSocket untuk data real-time
const ws = new WebSocket('wss://fstream.binance.com/ws');
const priceData = new Map();
const volumeData = new Map();
const orderBookData = new Map();

function connectWebSocket() {
  ws.on('open', () => {
    console.log('WebSocket connected');
    ws.send(JSON.stringify({
      method: "SUBSCRIBE",
      params: ["!ticker@arr", "!bookTicker"],
      id: 1
    }));
  });

  ws.on('message', (data) => {
    try {
      const parsedData = JSON.parse(data);
      if (Array.isArray(parsedData)) {
        parsedData.forEach(ticker => {
          if (ticker.s) {
            priceData.set(ticker.s, parseFloat(ticker.c));
            volumeData.set(ticker.s, parseFloat(ticker.v));
          }
        });
      } else if (parsedData.b && parsedData.a) {
        orderBookData.set(ticker.s, {
          bid: parseFloat(parsedData.b),
          ask: parseFloat(parsedData.a),
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket disconnected, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
}
connectWebSocket();

// Variabel penyimpanan
const userKeysFile = 'userApiKeysFix.json';
const userApiKeys = {};
const userSettings = {};
const stopLossMessages = {};
const searchCoinMessages = {};
const BLACKLIST = ['CRVUSDT', 'MKRUSDT', 'RSRUSDT', 'CETUSUSDT', 'BNXUSDT', 'CKBUSDT'];
const lastTradeTime = {};
const tradingActive = {};
const generatedImages = {};
const apiRateLimits = new Map();

// Default settings
const DEFAULT_SETTINGS = {
  minLeverage: 25,
  maxPositions: 5,
  basePositionSizePercent: 0.10,
  minBalancePercent: 0.20,
  trailingStopPercent: 0.02,
  takeProfitPercent: 0.05,
  trailingTakeProfitPercent: 0.03,
  timeframe: '4h',
  sentimentThreshold: 0.2,
  maxIdleTime: 30 * 60 * 1000,
  stagnationThreshold: 60 * 60 * 1000,
  favoriteSymbols: [],
  hedgingEnabled: true,
  reentryThreshold: 0.015,
  portfolioBalanceFactor: 0.8
};

// Statistik trading
const tradingStats = {};
const performanceHistory = {};

// Kata-kata untuk analisis sentimen
const POSITIVE_WORDS = ['bullish', 'up', 'gain', 'profit', 'buy', 'pump', 'moon', 'strong'];
const NEGATIVE_WORDS = ['bearish', 'down', 'loss', 'sell', 'dump', 'crash', 'weak'];

function loadUserApiKeys() {
  if (fs.existsSync(userKeysFile)) {
    const data = fs.readFileSync(userKeysFile, 'utf8');
    const keys = JSON.parse(data);
    for (const chatId in keys) {
      userApiKeys[chatId] = {
        apiKey: keys[chatId].apiKey, // Tanpa dekripsi
        secretKey: keys[chatId].secretKey // Tanpa dekripsi
      };
      userSettings[chatId] = { ...DEFAULT_SETTINGS };
      performanceHistory[chatId] = [];
    }
  }
}

function saveUserApiKeys() {
  fs.writeFileSync(userKeysFile, JSON.stringify(userApiKeys, null, 2)); // Simpan tanpa enkripsi
}

loadUserApiKeys();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_ANAL;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userIntervals = {};

function roundTickSize(price, tickSize) {
  const precision = Math.log10(1 / parseFloat(tickSize));
  return Number((Math.round(price * Math.pow(10, precision)) / Math.pow(10, precision)).toFixed(precision));
}

function roundStepSize(quantity, stepSize) {
  const precision = Math.log10(1 / parseFloat(stepSize));
  return Number((Math.round(quantity * Math.pow(10, precision)) / Math.pow(10, precision)).toFixed(precision));
}

async function apiRequest(method, url, apiKey, secretKey, params = {}) {
  const rateKey = `${apiKey}_${method}`;
  const now = Date.now();
  const limit = apiRateLimits.get(rateKey) || { count: 0, reset: now + 60000 };
  if (limit.count >= 1200) {
    await sleep(limit.reset - now);
  }
  limit.count++;
  apiRateLimits.set(rateKey, limit);

  const timestamp = Date.now();
  const queryString = Object.keys(params).map(k => `${k}=${params[k]}`).join('&') + `&timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
  const fullUrl = `${url}?${queryString}&signature=${signature}`;

  for (let i = 0; i < 3; i++) {
    try {
      const response = await axios({
        method,
        url: fullUrl,
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      if (limit.count === 1) limit.reset = Date.now() + 60000;
      return response;
    } catch (error) {
      if (i < 2) await sleep(5000);
      else throw error;
    }
  }
}

async function getSymbolInfo(symbol) {
  const cached = candleCache.get(`symbolInfo_${symbol}`);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached;

  const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
  const info = {
    ...symbolInfo,
    maxLeverage: parseInt(symbolInfo.filters.find(f => f.filterType === 'LEVERAGE')?.maxLeverage || 125)
  };
  candleCache.set(`symbolInfo_${symbol}`, info);
  return info;
}

async function getBinanceFuturesBalance(apiKey, secretKey) {
  const response = await apiRequest('get', 'https://fapi.binance.com/fapi/v2/balance', apiKey, secretKey, { timestamp: Date.now() });
  return response.data;
}

async function getBinanceOpenPositions(apiKey, secretKey) {
  const response = await apiRequest('get', 'https://fapi.binance.com/fapi/v2/positionRisk', apiKey, secretKey, { timestamp: Date.now() });
  return response.data.filter(position => parseFloat(position.positionAmt) !== 0) || [];
}

async function setLeverage(apiKey, secretKey, symbol, leverage) {
  const params = { symbol, leverage, timestamp: Date.now() };
  return await apiRequest('post', 'https://fapi.binance.com/fapi/v1/leverage', apiKey, secretKey, params);
}

async function openPosition(chatId, apiKey, secretKey, symbol, side, quantity, timeFrame, sentimentScore, leverage, opportunityScore) {
  const params = { symbol, side, type: 'MARKET', quantity, timestamp: Date.now() };
  const response = await apiRequest('post', 'https://fapi.binance.com/fapi/v1/order', apiKey, secretKey, params);
  const position = (await getBinanceOpenPositions(apiKey, secretKey)).find(p => p.symbol === symbol);
  const entryPrice = parseFloat(position.entryPrice);
  const marginValue = (quantity * entryPrice).toFixed(2);

  await bot.sendMessage(chatId,
    `✅ ${symbol} ${side === 'BUY' ? 'Long' : 'Short'} opened\n` +
    `Price: $${entryPrice.toFixed(2)}\n` +
    `Margin: $${marginValue}\n` +
    `Leverage: ${leverage}x\n` +
    `Timeframe: ${timeFrame}\n` +
    `Sentiment: ${sentimentScore.toFixed(2)}\n` +
    `Opportunity Score: ${opportunityScore.toFixed(2)}`
  );

  if (!tradingStats[chatId]) tradingStats[chatId] = { trades: 0, profit: 0, competitorProfit: 0 };
  tradingStats[chatId].trades++;
  lastTradeTime[chatId] = Date.now();
  performanceHistory[chatId].push({ symbol, side, entryPrice, timestamp: Date.now() });
  return { entryPrice, quantity };
}

async function setStopLossMarket(apiKey, secretKey, symbol, stopPrice, quantity, isLong) {
  const side = isLong ? 'SELL' : 'BUY';
  const symbolInfo = await getSymbolInfo(symbol);
  const tickSize = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize;
  const validStopPrice = roundTickSize(stopPrice, tickSize);
  const params = { symbol, side, type: 'STOP_MARKET', quantity, stopPrice: validStopPrice, timestamp: Date.now() };
  return await apiRequest('post', 'https://fapi.binance.com/fapi/v1/order', apiKey, secretKey, params);
}

async function setTakeProfitMarket(apiKey, secretKey, symbol, takeProfitPrice, quantity, isLong) {
  const side = isLong ? 'SELL' : 'BUY';
  const symbolInfo = await getSymbolInfo(symbol);
  const tickSize = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize;
  const validPrice = roundTickSize(takeProfitPrice, tickSize);
  const params = { symbol, side, type: 'TAKE_PROFIT_MARKET', quantity, stopPrice: validPrice, timestamp: Date.now() };
  return await apiRequest('post', 'https://fapi.binance.com/fapi/v1/order', apiKey, secretKey, params);
}

async function getCandles(symbol, interval, limit = 100) {
  const cacheKey = `${symbol}_${interval}_${limit}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached;

  const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const candles = response.data.map(candle => ({
    time: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
  }));
  candleCache.set(cacheKey, candles);
  return candles;
}

async function getSentimentScore(chatId, symbol) {
  const coin = symbol.replace('USDT', '');
  const cacheKey = `${coin}_sentiment`;
  const cached = sentimentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached;

  let posts;
  try {
    posts = await searchXPosts(coin);
  } catch (error) {
    console.error(`Error fetching X posts for ${coin}:`, error);
    return 0;
  }

  let sentimentScore = 0;
  const postCount = posts.length;
  for (const post of posts) {
    const text = post.text.toLowerCase();
    const influence = post.user.followers_count > 10000 ? 1.5 : 1;
    const positiveWeight = POSITIVE_WORDS.reduce((sum, word) => sum + (text.includes(word) ? 0.2 : 0), 0);
    const negativeWeight = NEGATIVE_WORDS.reduce((sum, word) => sum + (text.includes(word) ? 0.2 : 0), 0);
    sentimentScore += (positiveWeight - negativeWeight) * influence;

    if (post.attachments) {
      sentimentScore += post.attachments.includes('bullish_chart') ? 0.1 : 0;
    }
  }

  const webResults = await webSearch(`${coin} crypto news`);
  webResults.forEach(result => {
    sentimentScore += result.title.toLowerCase().includes('bullish') ? 0.1 : (result.title.toLowerCase().includes('bearish') ? -0.1 : 0);
  });

  sentimentScore = postCount > 0 ? Math.max(-1, Math.min(1, sentimentScore / (postCount * 0.5))) : 0;
  sentimentCache.set(cacheKey, sentimentScore);

  if (Math.abs(sentimentScore) > 0.8) {
    await bot.sendMessage(chatId, `🚨 Strong sentiment detected for ${symbol}: ${sentimentScore.toFixed(2)}`);
  }

  return sentimentScore;
}

async function searchXPosts(query) {
  const searchResults = await xSearch(query, 50);
  return searchResults.map(post => ({
    text: post.text,
    user: { followers_count: post.user?.followers_count || 1000 },
    attachments: post.attachments || []
  }));
}

async function xSearch(query, limit) {
  console.log(`Searching X for "${query}" with limit ${limit}`);
  const posts = await new Promise((resolve) => {
    setTimeout(() => {
      resolve(Array.from({ length: limit }, (_, i) => ({
        text: `Post ${i} about ${query}`,
        user: { followers_count: Math.random() > 0.7 ? 15000 : 500 },
        attachments: Math.random() > 0.9 ? ['bullish_chart'] : []
      })));
    }, 1000); // Simulasi
  });
  return posts;
}

async function webSearch(query) {
  console.log(`Searching web for "${query}"`);
  return await new Promise((resolve) => {
    setTimeout(() => {
      resolve([{ title: `${query} update` }]);
    }, 500); // Simulasi
  });
}

async function predictPrice(candles, sentimentScore) {
  const lastClose = candles[candles.length - 1].close;
  const avgChange = candles.slice(-10).reduce((sum, c) => sum + (c.close - c.open), 0) / 10;
  const volatility = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close), period: 14 }).slice(-1)[0];
  return lastClose + (avgChange * (1 + sentimentScore) + volatility * sentimentScore * 0.5);
}

function calculateSupportResistance(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  return {
    supportLevels: [...new Set(lows)].sort((a, b) => a - b).slice(0, 3),
    resistanceLevels: [...new Set(highs)].sort((a, b) => b - a).slice(0, 3)
  };
}

function calculateMACD(candles) {
  return MACD.calculate({ values: candles.map(c => c.close), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
}

function calculateBollingerBands(candles) {
  return BollingerBands.calculate({ values: candles.map(c => c.close), period: 20, stdDev: 2 });
}

function calculateRSI(candles) {
  return RSI.calculate({ values: candles.map(c => c.close), period: 14 });
}

function calculateEMA(candles, period) {
  return EMA.calculate({ values: candles.map(c => c.close), period });
}

function calculateATR(candles) {
  return ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close), period: 14 });
}

function calculateSharpeRatio(history) {
  if (history.length < 10) return 1;
  const returns = history.map(h => h.profit / h.entryPrice);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
  return stdDev === 0 ? 1 : avgReturn / stdDev;
}

function isBounceFromSupport(candle, supportLevel) {
  const tolerance = supportLevel * 0.01;
  if (Math.abs(candle.low - supportLevel) > tolerance) return false;
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return (lowerWick / range) > 0.5 && candle.close > candle.open;
}

function isBounceFromResistance(candle, resistanceLevel) {
  const tolerance = resistanceLevel * 0.01;
  if (Math.abs(candle.high - resistanceLevel) > tolerance) return false;
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return (upperWick / range) > 0.5 && candle.close < candle.open;
}

function isBreakout(candles, resistanceLevel) {
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  return prevCandle.close < resistanceLevel && lastCandle.close > resistanceLevel && lastCandle.close > lastCandle.open;
}

function detectAnomaly(candles, volumeStrength) {
  const lastCandle = candles[candles.length - 1];
  const avgVolume = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
  const priceChange = Math.abs(lastCandle.close - candles[candles.length - 2].close) / lastCandle.close;
  return priceChange > 0.05 || volumeStrength > 3;
}

function calculateOpportunityScore({ lastMACD, lastBB, lastRSI, lastCandle, lastEMAFast, lastEMASlow, sentimentScore, supportLevels, resistanceLevels, volumeStrength, orderBookPressure, atr, predictedPrice, lastClose, sharpeRatio, multiTimeframeScore }) {
  let score = 0;

  if (lastMACD.histogram > 0) score += 0.15;
  if (lastCandle.close < lastBB.lower || lastCandle.close > lastBB.upper) score += 0.15;
  if (lastRSI < 30 || lastRSI > 70) score += 0.15;
  if (lastEMAFast > lastEMASlow || lastEMAFast < lastEMASlow) score += 0.15;
  if (isBounceFromSupport(lastCandle, supportLevels[0]) || isBounceFromResistance(lastCandle, resistanceLevels[0]) || isBreakout(candles.slice(-2), resistanceLevels[0])) score += 0.2;
  score += volumeStrength * 0.1;
  score += orderBookPressure * 0.1;
  score += Math.abs(sentimentScore) * 0.3;
  score += (atr / lastCandle.close) * 0.2;
  score += Math.abs(predictedPrice - lastClose) / lastClose * 0.15;
  score += sharpeRatio * 0.1;
  score += multiTimeframeScore * 0.2;

  return Math.min(1, score);
}

async function multiTimeframeAnalysis(symbol) {
  const timeframes = ['1h', '4h', '1d'];
  let score = 0;
  for (const tf of timeframes) {
    const candles = await getCandles(symbol, tf, 50);
    const emaFast = calculateEMA(candles, 9).slice(-1)[0];
    const emaSlow = calculateEMA(candles, 21).slice(-1)[0];
    score += (emaFast > emaSlow ? 0.1 : emaFast < emaSlow ? -0.1 : 0);
  }
  return score / timeframes.length;
}

async function monitorStopLossAndProfit(chatId, apiKey, secretKey) {
  if (!tradingActive[chatId]) return;

  const openPositions = await getBinanceOpenPositions(apiKey, secretKey);
  const settings = userSettings[chatId];
  const currentTime = Date.now();
  const balance = await getBinanceFuturesBalance(apiKey, secretKey);
  const usdtBalance = balance.find(asset => asset.asset === 'USDT');
  const availableBalance = parseFloat(usdtBalance.availableBalance);
  const totalBalance = parseFloat(usdtBalance.balance);

  for (const position of openPositions) {
    const symbol = position.symbol;
    const entryPrice = parseFloat(position.entryPrice);
    const currentPrice = priceData.get(symbol) || parseFloat(position.markPrice);
    const positionAmt = parseFloat(position.positionAmt);
    const isLong = positionAmt > 0;
    const quantity = Math.abs(positionAmt);
    const key = `${chatId}_${symbol}`;

    if (!trailingStopLevels[key]) {
      trailingStopLevels[key] = {
        stopLoss: isLong ? entryPrice * (1 - settings.trailingStopPercent) : entryPrice * (1 + settings.trailingStopPercent),
        takeProfit1: isLong ? entryPrice * (1 + settings.takeProfitPercent / 2) : entryPrice * (1 - settings.takeProfitPercent / 2),
        takeProfit2: isLong ? entryPrice * (1 + settings.takeProfitPercent) : entryPrice * (1 - settings.takeProfitPercent),
        trailingTakeProfit: isLong ? entryPrice * (1 + settings.trailingTakeProfitPercent) : entryPrice * (1 - settings.trailingTakeProfitPercent),
        highPrice: entryPrice,
        lowPrice: entryPrice,
        partialClosed1: false,
        partialClosed2: false,
        openTime: currentTime,
        hedgePosition: null
      };
      await setStopLossMarket(apiKey, secretKey, symbol, trailingStopLevels[key].stopLoss, quantity, isLong);
      await setTakeProfitMarket(apiKey, secretKey, symbol, trailingStopLevels[key].takeProfit1, quantity / 3, isLong);
      await setTakeProfitMarket(apiKey, secretKey, symbol, trailingStopLevels[key].takeProfit2, quantity / 3, isLong);
    }

    const trail = trailingStopLevels[key];
    const priceChange = Math.abs(currentPrice - entryPrice) / entryPrice;

    if (currentTime - trail.openTime > settings.stagnationThreshold && priceChange < 0.01) {
      const side = isLong ? 'SELL' : 'BUY';
      await openPosition(chatId, apiKey, secretKey, symbol, side, quantity, 'stagnant close', 0, 25, 0);
      await bot.sendMessage(chatId, `⚠️ ${symbol} closed due to stagnation`);
      delete trailingStopLevels[key];
      continue;
    }

    if (isLong) {
      if (currentPrice > trail.highPrice) {
        trail.highPrice = currentPrice;
        const newStopLoss = currentPrice * (1 - settings.trailingStopPercent);
        const newTrailingTakeProfit = currentPrice * (1 - settings.trailingTakeProfitPercent);
        if (newStopLoss > trail.stopLoss) {
          trail.stopLoss = newStopLoss;
          await setStopLossMarket(apiKey, secretKey, symbol, trail.stopLoss, quantity, isLong);
          await bot.sendMessage(chatId, `🛑 ${symbol} Trailing Stop: $${trail.stopLoss.toFixed(2)}`);
        }
        if (!trail.partialClosed1 && currentPrice >= trail.takeProfit1) {
          trail.partialClosed1 = true;
          quantity -= quantity / 3;
          await bot.sendMessage(chatId, `🎉 ${symbol} Take Profit 1 at $${currentPrice.toFixed(2)}`);
        }
        if (!trail.partialClosed2 && currentPrice >= trail.takeProfit2) {
          trail.partialClosed2 = true;
          quantity -= quantity / 3;
          await bot.sendMessage(chatId, `🎉 ${symbol} Take Profit 2 at $${currentPrice.toFixed(2)}`);
        }
        if (newTrailingTakeProfit > trail.trailingTakeProfit) {
          trail.trailingTakeProfit = newTrailingTakeProfit;
          await setTakeProfitMarket(apiKey, secretKey, symbol, trail.trailingTakeProfit, quantity, isLong);
        }
      }
      if (currentPrice <= trail.stopLoss || currentPrice >= trail.trailingTakeProfit) {
        const profit = isLong ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
        tradingStats[chatId].profit += profit;
        performanceHistory[chatId].push({ profit, entryPrice });
        await bot.sendMessage(chatId, `${currentPrice <= trail.stopLoss ? '🚨 Stop Loss' : '🎉 Full Take Profit'} ${symbol} at $${currentPrice.toFixed(2)}, Profit: $${profit.toFixed(2)}`);
        delete trailingStopLevels[key];

        if (Math.abs(currentPrice - entryPrice) / entryPrice < settings.reentryThreshold) {
          await reEnterPosition(chatId, apiKey, secretKey, symbol, isLong ? 'BUY' : 'SELL');
        }
      }
      if (settings.hedgingEnabled && !trail.hedgePosition && priceChange > 0.1) {
        trail.hedgePosition = await openHedgePosition(chatId, apiKey, secretKey, symbol, quantity / 2, !isLong);
      }
    } else {
      if (currentPrice < trail.lowPrice) {
        trail.lowPrice = currentPrice;
        const newStopLoss = currentPrice * (1 + settings.trailingStopPercent);
        const newTrailingTakeProfit = currentPrice * (1 + settings.trailingTakeProfitPercent);
        if (newStopLoss < trail.stopLoss) {
          trail.stopLoss = newStopLoss;
          await setStopLossMarket(apiKey, secretKey, symbol, trail.stopLoss, quantity, isLong);
          await bot.sendMessage(chatId, `🛑 ${symbol} Trailing Stop: $${trail.stopLoss.toFixed(2)}`);
        }
        if (!trail.partialClosed1 && currentPrice <= trail.takeProfit1) {
          trail.partialClosed1 = true;
          quantity -= quantity / 3;
          await bot.sendMessage(chatId, `🎉 ${symbol} Take Profit 1 at $${currentPrice.toFixed(2)}`);
        }
        if (!trail.partialClosed2 && currentPrice <= trail.takeProfit2) {
          trail.partialClosed2 = true;
          quantity -= quantity / 3;
          await bot.sendMessage(chatId, `🎉 ${symbol} Take Profit 2 at $${currentPrice.toFixed(2)}`);
        }
        if (newTrailingTakeProfit < trail.trailingTakeProfit) {
          trail.trailingTakeProfit = newTrailingTakeProfit;
          await setTakeProfitMarket(apiKey, secretKey, symbol, trail.trailingTakeProfit, quantity, isLong);
        }
      }
      if (currentPrice >= trail.stopLoss || currentPrice <= trail.trailingTakeProfit) {
        const profit = isLong ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
        tradingStats[chatId].profit += profit;
        performanceHistory[chatId].push({ profit, entryPrice });
        await bot.sendMessage(chatId, `${currentPrice >= trail.stopLoss ? '🚨 Stop Loss' : '🎉 Full Take Profit'} ${symbol} at $${currentPrice.toFixed(2)}, Profit: $${profit.toFixed(2)}`);
        delete trailingStopLevels[key];

        if (Math.abs(currentPrice - entryPrice) / entryPrice < settings.reentryThreshold) {
          await reEnterPosition(chatId, apiKey, secretKey, symbol, isLong ? 'BUY' : 'SELL');
        }
      }
      if (settings.hedgingEnabled && !trail.hedgePosition && priceChange > 0.1) {
        trail.hedgePosition = await openHedgePosition(chatId, apiKey, secretKey, symbol, quantity / 2, !isLong);
      }
    }
  }

  const idleTime = currentTime - (lastTradeTime[chatId] || 0);
  if ((openPositions.length < settings.maxPositions || idleTime > settings.maxIdleTime) && availableBalance > totalBalance * settings.minBalancePercent) {
    await fillEmptyPositions(chatId, apiKey, secretKey, openPositions.length, availableBalance);
  }
}

async function openHedgePosition(chatId, apiKey, secretKey, symbol, quantity, isLong) {
  const side = isLong ? 'BUY' : 'SELL';
  const symbolInfo = await getSymbolInfo(symbol);
  const leverage = Math.min(25, symbolInfo.maxLeverage);
  await setLeverage(apiKey, secretKey, symbol, leverage);
  const { entryPrice } = await openPosition(chatId, apiKey, secretKey, symbol, side, quantity, 'hedge', 0, leverage, 0);
  await bot.sendMessage(chatId, `🛡️ Hedge position opened for ${symbol} at $${entryPrice.toFixed(2)}`);
  return { symbol, quantity, entryPrice };
}

async function reEnterPosition(chatId, apiKey, secretKey, symbol, side) {
  const settings = userSettings[chatId];
  const symbolInfo = await getSymbolInfo(symbol);
  const candles = await getCandles(symbol, settings.timeframe);
  const lastCandle = candles[candles.length - 1];
  const sentimentScore = await getSentimentScore(chatId, symbol);
  const sharpeRatio = calculateSharpeRatio(performanceHistory[chatId]);
  const multiTimeframeScore = await multiTimeframeAnalysis(symbol);

  const positionSizePercent = settings.basePositionSizePercent * sharpeRatio;
  const positionSize = (availableBalance * positionSizePercent) / lastCandle.close;
  const quantity = roundStepSize(positionSize, symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize);
  const leverage = Math.floor(settings.minLeverage + (symbolInfo.maxLeverage - settings.minLeverage) * 0.5);

  await setLeverage(apiKey, secretKey, symbol, leverage);
  await openPosition(chatId, apiKey, secretKey, symbol, side, quantity, settings.timeframe, sentimentScore, leverage, 0.5);
}

async function fillEmptyPositions(chatId, apiKey, secretKey, currentPositions, availableBalance) {
  if (!tradingActive[chatId]) return;

  const settings = userSettings[chatId];
  const symbols = settings.favoriteSymbols.length > 0 ? settings.favoriteSymbols : Object.keys(cryptoMapping).map(key => key.toUpperCase() + 'USDT');
  const opportunities = [];

  for (const symbol of symbols) {
    if (BLACKLIST.includes(symbol) || currentPositions.some(p => p.symbol === symbol)) continue;

    const candles = await getCandles(symbol, settings.timeframe);
    if (!candles) continue;

    const { supportLevels, resistanceLevels } = calculateSupportResistance(candles);
    const macd = calculateMACD(candles);
    const bb = calculateBollingerBands(candles);
    const rsi = calculateRSI(candles);
    const emaFast = calculateEMA(candles, 9);
    const emaSlow = calculateEMA(candles, 21);
    const atr = calculateATR(candles);
    const lastCandle = candles[candles.length - 1];
    const lastMACD = macd[macd.length - 1];
    const lastBB = bb[bb.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastEMAFast = emaFast[emaFast.length - 1];
    const lastEMASlow = emaSlow[emaSlow.length - 1];
    const lastATR = atr[atr.length - 1];
    const volumeAvg = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
    const volumeStrength = volumeData.get(symbol) / volumeAvg || 1;
    const orderBook = orderBookData.get(symbol) || { bid: lastCandle.close, ask: lastCandle.close };
    const orderBookPressure = (orderBook.bid - orderBook.ask) / lastCandle.close;
    const sentimentScore = await getSentimentScore(chatId, symbol);
    const predictedPrice = await predictPrice(candles, sentimentScore);
    const sharpeRatio = calculateSharpeRatio(performanceHistory[chatId]);
    const multiTimeframeScore = await multiTimeframeAnalysis(symbol);

    const opportunityScore = calculateOpportunityScore({
      lastMACD, lastBB, lastRSI, lastCandle, lastEMAFast, lastEMASlow, sentimentScore, supportLevels, resistanceLevels, volumeStrength, orderBookPressure, atr: lastATR, predictedPrice, lastClose: lastCandle.close, sharpeRatio, multiTimeframeScore
    });

    opportunities.push({ symbol, score: opportunityScore, sentimentScore, lastCandle, lastATR });
  }

  opportunities.sort((a, b) => b.score - a.score);
  const slotsToFill = settings.maxPositions - currentPositions;
  const balancePerPosition = availableBalance * settings.portfolioBalanceFactor / settings.maxPositions;

  for (let i = 0; i < Math.min(slotsToFill, opportunities.length); i++) {
    const { symbol, score, sentimentScore, lastCandle, lastATR } = opportunities[i];
    const symbolInfo = await getSymbolInfo(symbol);
    const stepSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize;

    const volatilityFactor = Math.min(2, lastATR / lastCandle.close * 10);
    const positionSizePercent = settings.basePositionSizePercent * calculateSharpeRatio(performanceHistory[chatId]);
    const positionSize = Math.min(balancePerPosition * volatilityFactor, availableBalance * positionSizePercent) / lastCandle.close;
    const quantity = roundStepSize(positionSize, stepSize);

    const minLeverage = settings.minLeverage;
    const maxLeverage = symbolInfo.maxLeverage;
    const leverage = Math.floor(minLeverage + (maxLeverage - minLeverage) * Math.pow(score, 2));

    let action = sentimentScore > 0 ? 'long' : 'short';
    await setLeverage(apiKey, secretKey, symbol, leverage);
    await openPosition(chatId, apiKey, secretKey, symbol, action === 'long' ? 'BUY' : 'SELL', quantity, settings.timeframe, sentimentScore, leverage, score);
  }
}

async function searchCoinWithIndicators(chatId, apiKey, secretKey) {
  if (!tradingActive[chatId]) return;

  const settings = userSettings[chatId];
  const balance = await getBinanceFuturesBalance(apiKey, secretKey);
  const usdtBalance = balance.find(asset => asset.asset === 'USDT');
  const availableBalance = parseFloat(usdtBalance.availableBalance);
  const totalBalance = parseFloat(usdtBalance.balance);

  if (availableBalance < totalBalance * settings.minBalancePercent) return;
  const openPositions = await getBinanceOpenPositions(apiKey, secretKey);

  const symbols = settings.favoriteSymbols.length > 0 ? settings.favoriteSymbols : Object.keys(cryptoMapping).map(key => key.toUpperCase() + 'USDT');
  for (const symbol of symbols) {
    if (BLACKLIST.includes(symbol) || openPositions.some(p => p.symbol === symbol)) continue;

    const candles = await getCandles(symbol, settings.timeframe);
    if (!candles) continue;

    const { supportLevels, resistanceLevels } = calculateSupportResistance(candles);
    const macd = calculateMACD(candles);
    const bb = calculateBollingerBands(candles);
    const rsi = calculateRSI(candles);
    const emaFast = calculateEMA(candles, 9);
    const emaSlow = calculateEMA(candles, 21);
    const atr = calculateATR(candles);
    const lastCandle = candles[candles.length - 1];
    const lastMACD = macd[macd.length - 1];
    const lastBB = bb[bb.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastEMAFast = emaFast[emaFast.length - 1];
    const lastEMASlow = emaSlow[emaSlow.length - 1];
    const lastATR = atr[atr.length - 1];
    const volumeAvg = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
    const volumeStrength = volumeData.get(symbol) / volumeAvg || 1;
    const orderBook = orderBookData.get(symbol) || { bid: lastCandle.close, ask: lastCandle.close };
    const orderBookPressure = (orderBook.bid - orderBook.ask) / lastCandle.close;
    const sentimentScore = await getSentimentScore(chatId, symbol);
    const predictedPrice = await predictPrice(candles, sentimentScore);
    const sharpeRatio = calculateSharpeRatio(performanceHistory[chatId]);
    const multiTimeframeScore = await multiTimeframeAnalysis(symbol);

    let action = null;
    if (detectAnomaly(candles, volumeStrength)) {
      action = sentimentScore > 0 ? 'long' : 'short';
      await bot.sendMessage(chatId, `🚨 Anomaly detected for ${symbol}: High volatility or volume`);
    } else if (lastMACD.histogram > 0 && lastCandle.close < lastBB.lower && lastRSI < 30 && volumeStrength > 1.5 && isBounceFromSupport(lastCandle, supportLevels[0]) && sentimentScore > settings.sentimentThreshold) {
      action = 'long';
    } else if (lastMACD.histogram > 0 && lastCandle.close > lastBB.upper && lastRSI > 70 && volumeStrength > 1.5 && isBounceFromResistance(lastCandle, resistanceLevels[0]) && sentimentScore < -settings.sentimentThreshold) {
      action = 'short';
    } else if (lastEMAFast > lastEMASlow && candles[candles.length - 2].close < emaSlow[emaSlow.length - 2] && volumeStrength > 1.5 && sentimentScore > settings.sentimentThreshold) {
      action = 'long';
    } else if (lastEMAFast < lastEMASlow && candles[candles.length - 2].close > emaSlow[emaSlow.length - 2] && volumeStrength > 1.5 && sentimentScore < -settings.sentimentThreshold) {
      action = 'short';
    } else if (isBreakout(candles, resistanceLevels[0]) && volumeStrength > 2 && sentimentScore > settings.sentimentThreshold) {
      action = 'long';
    }

    if (action) {
      const symbolInfo = await getSymbolInfo(symbol);
      const stepSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize;

      const volatilityFactor = Math.min(2, lastATR / lastCandle.close * 10);
      const positionSizePercent = settings.basePositionSizePercent * sharpeRatio;
      const positionSize = (availableBalance * positionSizePercent * volatilityFactor) / lastCandle.close;
      const quantity = roundStepSize(positionSize, stepSize);

      const score = calculateOpportunityScore({
        lastMACD, lastBB, lastRSI, lastCandle, lastEMAFast, lastEMASlow, sentimentScore, supportLevels, resistanceLevels, volumeStrength, orderBookPressure, atr: lastATR, predictedPrice, lastClose: lastCandle.close, sharpeRatio, multiTimeframeScore
      });
      const minLeverage = settings.minLeverage;
      const maxLeverage = symbolInfo.maxLeverage;
      const leverage = Math.floor(minLeverage + (maxLeverage - minLeverage) * Math.pow(score, 2));

      await setLeverage(apiKey, secretKey, symbol, leverage);
      await openPosition(chatId, apiKey, secretKey, symbol, action === 'long' ? 'BUY' : 'SELL', quantity, settings.timeframe, sentimentScore, leverage, score);
    }
  }

  if (openPositions.length < settings.maxPositions) {
    await fillEmptyPositions(chatId, apiKey, secretKey, openPositions.length, availableBalance);
  }
}

async function backtestStrategy(chatId, symbol, timeframe) {
  const candles = await getCandles(symbol, timeframe, 500);
  let profit = 0;
  let trades = 0;

  for (let i = 20; i < candles.length - 1; i++) {
    const slice = candles.slice(0, i + 1);
    const { supportLevels, resistanceLevels } = calculateSupportResistance(slice);
    const macd = calculateMACD(slice);
    const bb = calculateBollingerBands(slice);
    const rsi = calculateRSI(slice);
    const emaFast = calculateEMA(slice, 9);
    const emaSlow = calculateEMA(slice, 21);
    const lastCandle = slice[slice.length - 1];
    const lastMACD = macd[macd.length - 1];
    const lastBB = bb[bb.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastEMAFast = emaFast[emaFast.length - 1];
    const lastEMASlow = emaSlow[emaSlow.length - 1];

    let action = null;
    if (lastMACD.histogram > 0 && lastCandle.close < lastBB.lower && lastRSI < 30 && isBounceFromSupport(lastCandle, supportLevels[0])) {
      action = 'long';
    } else if (lastMACD.histogram > 0 && lastCandle.close > lastBB.upper && lastRSI > 70 && isBounceFromResistance(lastCandle, resistanceLevels[0])) {
      action = 'short';
    }

    if (action) {
      const entryPrice = candles[i + 1].open;
      const exitPrice = action === 'long' ? entryPrice * 1.05 : entryPrice * 0.95;
      profit += action === 'long' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      trades++;
    }
  }

  await bot.sendMessage(chatId, `📈 Backtest ${symbol} (${timeframe})\nTrades: ${trades}\nProfit: $${profit.toFixed(2)}`);
}

async function analyzeCompetitors(chatId) {
  const posts = await xSearch('crypto trading profit', 50);
  let competitorProfit = 0;
  posts.forEach(post => {
    const match = post.text.match(/profit.*?\$([\d.]+)/i);
    if (match) competitorProfit += parseFloat(match[1]);
  });
  tradingStats[chatId].competitorProfit = competitorProfit / posts.length || 0;
  await bot.sendMessage(chatId, `🏆 Competitor Avg Profit: $${tradingStats[chatId].competitorProfit.toFixed(2)}\nYour Profit: $${tradingStats[chatId].profit.toFixed(2)}`);
}

async function sendDailyReport(chatId) {
  const stats = tradingStats[chatId] || { trades: 0, profit: 0, competitorProfit: 0 };
  const balance = await getBinanceFuturesBalance(userApiKeys[chatId].apiKey, userApiKeys[chatId].secretKey);
  const usdtBalance = balance.find(asset => asset.asset === 'USDT');
  const sharpeRatio = calculateSharpeRatio(performanceHistory[chatId]);
  const message = `📊 *Daily Report*\n` +
    `Trades: ${stats.trades}\n` +
    `Profit: $${stats.profit.toFixed(2)}\n` +
    `Sharpe Ratio: ${sharpeRatio.toFixed(2)}\n` +
    `Competitor Avg Profit: $${stats.competitorProfit.toFixed(2)}\n` +
    `Balance: $${parseFloat(usdtBalance.balance).toFixed(2)}`;
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Perintah Telegram
bot.onText(/\/setapi (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const apiKey = match[1];
  const secretKey = match[2];

  if (!apiKey.match(/^[A-Za-z0-9]+$/) || !secretKey.match(/^[A-Za-z0-9]+$/)) {
    await bot.sendMessage(chatId, '❌ Invalid API key format');
    return;
  }

  userApiKeys[chatId] = { apiKey, secretKey };
  userSettings[chatId] = { ...DEFAULT_SETTINGS };
  saveUserApiKeys();
  await bot.sendMessage(chatId, '✅ API keys set. Use /startTrading to begin.');
});

bot.onText(/\/startTrading/, async (msg) => {
  const chatId = msg.chat.id;
  const { apiKey, secretKey } = userApiKeys[chatId] || {};
  if (!apiKey) return await bot.sendMessage(chatId, '❌ Set API keys first with /setapi');

  tradingActive[chatId] = true;
  userIntervals[chatId] = {
    searchInterval: setInterval(() => searchCoinWithIndicators(chatId, apiKey, secretKey), 5 * 60 * 1000),
    monitorInterval: setInterval(() => monitorStopLossAndProfit(chatId, apiKey, secretKey), 5 * 1000),
    reportInterval: setInterval(() => sendDailyReport(chatId), 24 * 60 * 60 * 1000)
  };
  await bot.sendMessage(chatId, '✅ Trading started');
});

bot.onText(/\/stopTrading/, async (msg) => {
  const chatId = msg.chat.id;
  if (!userIntervals[chatId]) return await bot.sendMessage(chatId, '❌ Trading not active');

  tradingActive[chatId] = false;
  clearInterval(userIntervals[chatId].searchInterval);
  clearInterval(userIntervals[chatId].monitorInterval);
  clearInterval(userIntervals[chatId].reportInterval);
  delete userIntervals[chatId];
  await bot.sendMessage(chatId, '🛑 Trading stopped');
});

bot.onText(/\/settimeframe (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const timeframe = match[1];
  if (!['1h', '4h', '1d'].includes(timeframe)) {
    await bot.sendMessage(chatId, '❌ Invalid timeframe. Use 1h, 4h, or 1d');
    return;
  }
  userSettings[chatId].timeframe = timeframe;
  await bot.sendMessage(chatId, `✅ Timeframe set to ${timeframe}`);
});

bot.onText(/\/setparams (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const params = match[1].split(' ');
  const settings = userSettings[chatId];

  for (const param of params) {
    const [key, value] = param.split('=');
    switch (key) {
      case 'minLeverage': settings.minLeverage = Math.max(25, parseInt(value)); break;
      case 'positionSize': settings.basePositionSizePercent = Math.min(parseFloat(value), 0.5); break;
      case 'stopLoss': settings.trailingStopPercent = Math.min(parseFloat(value), 0.1); break;
      case 'takeProfit': settings.takeProfitPercent = Math.min(parseFloat(value), 0.2); break;
      case 'trailingTakeProfit': settings.trailingTakeProfitPercent = Math.min(parseFloat(value), 0.2); break;
      case 'sentimentThreshold': settings.sentimentThreshold = Math.min(parseFloat(value), 1); break;
      case 'maxIdleTime': settings.maxIdleTime = parseInt(value) * 60 * 1000; break;
      case 'stagnationThreshold': settings.stagnationThreshold = parseInt(value) * 60 * 1000; break;
      case 'favoriteSymbols': settings.favoriteSymbols = value.split(','); break;
      case 'hedgingEnabled': settings.hedgingEnabled = value.toLowerCase() === 'true'; break;
      case 'reentryThreshold': settings.reentryThreshold = Math.min(parseFloat(value), 0.05); break;
      case 'portfolioBalanceFactor': settings.portfolioBalanceFactor = Math.min(parseFloat(value), 1); break;
      default: await bot.sendMessage(chatId, `❌ Unknown param: ${key}`); return;
    }
  }
  await bot.sendMessage(chatId, '✅ Parameters updated');
});

bot.onText(/\/fclose (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const { apiKey, secretKey } = userApiKeys[chatId] || {};
  if (!apiKey) return await bot.sendMessage(chatId, '❌ Set API keys first');

  const target = match[1].toUpperCase();
  const positions = await getBinanceOpenPositions(apiKey, secretKey);
  const toClose = target === 'ALL' ? positions : positions.filter(p => p.symbol === target);

  for (const pos of toClose) {
    const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
    await openPosition(chatId, apiKey, secretKey, pos.symbol, side, Math.abs(parseFloat(pos.positionAmt)), 'manual close', 0, 25, 0);
  }
});

bot.onText(/\/backtest (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase() + 'USDT';
  const timeframe = match[2];
  if (!['1h', '4h', '1d'].includes(timeframe)) {
    await bot.sendMessage(chatId, '❌ Invalid timeframe. Use 1h, 4h, or 1d');
    return;
  }
  await backtestStrategy(chatId, symbol, timeframe);
});

bot.onText(/\/generateChart (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase() + 'USDT';
  await bot.sendMessage(chatId, `Do you want me to generate a chart for ${symbol}? Reply with "yes" or "no".`, { reply_to_message_id: msg.message_id });
  bot.once('message', async (response) => {
    if (response.text.toLowerCase() === 'yes') {
      const imageId = `${chatId}_${Date.now()}`;
      generatedImages[imageId] = { symbol, data: 'simulated_chart_data' };
      await bot.sendMessage(chatId, `📊 Chart for ${symbol} generated (ID: ${imageId}). Use /editChart ${imageId} <annotation> to edit.`);
    }
  });
});

bot.onText(/\/editChart (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const imageId = match[1];
  const annotation = match[2];
  if (!generatedImages[imageId]) {
    await bot.sendMessage(chatId, '❌ Image not found or not generated by me');
    return;
  }
  generatedImages[imageId].annotation = annotation;
  await bot.sendMessage(chatId, `✏️ Chart ${imageId} edited with annotation: "${annotation}"`);
});

bot.onText(/\/analyzeCompetitors/, async (msg) => {
  const chatId = msg.chat.id;
  await analyzeCompetitors(chatId);
});

const trailingStopLevels = {};
