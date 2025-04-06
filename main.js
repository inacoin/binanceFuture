require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { RSI, EMA, MACD, BollingerBands, IchimokuCloud, SMA } = require('technicalindicators');
const crypto = require('crypto');
const WebSocket = require('ws');

// Inisialisasi data cryptoMapping dari file
let cryptoMapping = {};
try {
  cryptoMapping = JSON.parse(fs.readFileSync('cryptoMapping.json', 'utf8'));
  console.log('Crypto mapping loaded successfully.');
} catch (err) {
  console.error('Error loading crypto mapping:', err);
}

// Inisialisasi WebSocket Binance untuk update harga real-time
const ws = new WebSocket('wss://fstream.binance.com/ws');
const realTimePrices = new Map(); // Penyimpanan harga real-time: Key: symbol, Value: { price, timestamp }

ws.on('open', function open() {
  console.log('WebSocket connected');
  ws.send(JSON.stringify({
    method: "SUBSCRIBE",
    params: ["!ticker@arr"], // Mendapatkan semua ticker update
    id: 1
  }));
});

// Perbaikan: Pemanfaatan data real-time dari WebSocket
ws.on('message', async function incoming(data) {
  try {
    const parsedData = JSON.parse(data);
    if (!Array.isArray(parsedData)) return;

    parsedData.forEach(ticker => {
      const symbol = ticker.s;
      const price = parseFloat(ticker.c);
      if (symbol && !isNaN(price)) {
        realTimePrices.set(symbol, { price, timestamp: Date.now() });
        triggerRealTimeTrade(symbol, price); // Panggil fungsi untuk memicu trading real-time
      }
    });
  } catch (error) {
    console.error('Error parsing WebSocket message:', error);
  }
});

// File dan variabel penyimpanan
const userKeysFile = 'userApiKeysFix.json';
const userApiKeys = {};
const stopLossMessages = {};
const searchNotificationMessages = {};
const searchCoinMessages = {};
const balanceOrdersMessages = {};
const balanceNotificationMessages = {};
const BLACKLIST = ['CRVUSDT', 'MKRUSDT', 'RSRUSDT', 'CETUSUSDT', 'BNXUSDT', 'CKBUSDT'];
const TRAILING_STOP_PERCENT = 100;
const trailingStopLevels = {};
const MIN_LEVERAGE = 50;
let isSearching = false;
const processingCoins = {};
const userIntervals = {};
const balanceMessages = {};

// Perbaikan: Fungsi utilitas untuk error handling
async function handleError(chatId, context, error, notifyUser = true) {
  const errorMessage = `${context}: ${error.message || 'Unknown error'}`;
  console.error(errorMessage, error.stack);
  if (notifyUser && chatId) {
    await sendMessageWithRetry(chatId, `❌ ${errorMessage}`);
  }
  return null;
}

function loadUserApiKeys() {
  if (fs.existsSync(userKeysFile)) {
    try {
      const data = fs.readFileSync(userKeysFile, 'utf8');
      const keys = JSON.parse(data);
      Object.assign(userApiKeys, keys);
      console.log('API keys loaded successfully.');
    } catch (err) {
      console.error('Error reading API keys file:', err);
    }
  }
}

function saveUserApiKeys() {
  try {
    fs.writeFileSync(userKeysFile, JSON.stringify(userApiKeys, null, 2));
    console.log('API keys saved successfully.');
  } catch (err) {
    console.error('Error saving API keys:', err);
  }
}

loadUserApiKeys();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_ANAL;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}

function formatSmallNumber(value) {
  if (typeof value !== 'number' || isNaN(value)) return '0';
  if (value === 0) return '0';
  const formatted = value.toFixed(8);
  return formatted.replace(/\.?0+$/, '');
}

function roundTickSize(price, tickSize) {
  const precision = Math.log10(1 / parseFloat(tickSize));
  return Math.floor(price * Math.pow(10, precision)) / Math.pow(10, precision);
}

function roundStepSize(quantity, stepSize) {
  const precision = Math.log10(1 / parseFloat(stepSize));
  return Math.floor(quantity * Math.pow(10, precision)) / Math.pow(10, precision);
}

async function getSymbolInfo(symbol) {
  try {
    const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
    return response.data.symbols.find(s => s.symbol === symbol);
  } catch (error) {
    return handleError(null, `Failed to fetch symbol info for ${symbol}`, error, false);
  }
}

async function getPositionMode(apiKey, secretKey) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`;
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data.dualSidePosition;
  } catch (error) {
    return handleError(null, 'Error getting position mode', error, false);
  }
}

async function setPositionMode(apiKey, secretKey, mode = false) {
  try {
    const timestamp = Date.now();
    const queryString = `dualSidePosition=${mode}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`;
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    return handleError(null, 'Error setting position mode', error, false);
  }
}

async function getBinanceFuturesBalance(apiKey, secretKey) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v2/balance?${queryString}&signature=${signature}`;
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    return handleError(null, 'Error fetching balance', error, false);
  }
}

async function getBinanceOpenPositions(apiKey, secretKey) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v2/positionRisk?${queryString}&signature=${signature}`;
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data.filter(position => parseFloat(position.positionAmt) !== 0) || [];
  } catch (error) {
    return handleError(null, 'Error fetching positions', error, false) || [];
  }
}

async function getMaxLeverage(apiKey, secretKey, symbol) {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/leverageBracket?${queryString}&signature=${signature}`;
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const maxLeverage = response.data?.[0]?.brackets?.[0]?.initialLeverage || null;
    return maxLeverage >= MIN_LEVERAGE ? maxLeverage : null;
  } catch (error) {
    return handleError(null, `Error getting max leverage for ${symbol}`, error, false);
  }
}

async function setLeverage(apiKey, secretKey, symbol, leverage) {
  try {
    if (leverage < MIN_LEVERAGE) throw new Error(`Leverage must be at least ${MIN_LEVERAGE}x`);
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/leverage?${queryString}&signature=${signature}`;
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    return handleError(null, `Error setting leverage for ${symbol}`, error, false);
  }
}

async function sendMessageWithRetry(chatId, text, options) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    if (error.message.includes("429")) {
      const match = error.message.match(/retry after (\d+)/i);
      const retryAfter = match ? parseInt(match[1]) * 1000 : 15000;
      console.error(`Rate limit reached, retrying after ${retryAfter} ms`);
      await new Promise(resolve => setTimeout(resolve, retryAfter));
      return await bot.sendMessage(chatId, text, options);
    }
    throw error;
  }
}

async function openLongPositionMarket(chatId, apiKey, secretKey, symbol, quantity, timeFrame) {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=BUY&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;
    
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    const openPositions = await getBinanceOpenPositions(apiKey, secretKey);
    const position = openPositions.find(p => p.symbol === symbol);
    if (!position) throw new Error('Position not found after opening');
    
    const entryPrice = parseFloat(position.entryPrice);
    if (isNaN(entryPrice)) throw new Error('Invalid entry price');
    
    const marginValue = (quantity * entryPrice).toFixed(2);
    const leverage = position.leverage || 'N/A';
    
    await sendMessageWithRetry(chatId, 
      `✅ ${symbol} Long position opened\n` +
      `Market Price: $${entryPrice.toFixed(2)}\n` +
      `Margin: $${marginValue}\n` +
      `Leverage: ${leverage}x\n` +
      `Time Frame: ${timeFrame}`
    );
    return response.data;
  } catch (error) {
    return handleError(chatId, `Failed to open long position for ${symbol}`, error);
  }
}

async function openShortPositionMarket(chatId, apiKey, secretKey, symbol, quantity, timeFrame) {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;
    
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    const openPositions = await getBinanceOpenPositions(apiKey, secretKey);
    const position = openPositions.find(p => p.symbol === symbol);
    if (!position) throw new Error('Position not found after opening');
    
    const entryPrice = parseFloat(position.entryPrice);
    if (isNaN(entryPrice)) throw new Error('Invalid entry price');
    
    const marginValue = (quantity * entryPrice).toFixed(2);
    const leverage = position.leverage || 'N/A';
    
    await sendMessageWithRetry(chatId, 
      `✅ ${symbol} Short position opened\n` +
      `Market Price: $${entryPrice.toFixed(2)}\n` +
      `Margin: $${marginValue}\n` +
      `Leverage: ${leverage}x\n` +
      `Time Frame: ${timeFrame}`
    );
    return response.data;
  } catch (error) {
    return handleError(chatId, `Failed to open short position for ${symbol}`, error);
  }
}

async function setStopLossMarket(apiKey, secretKey, symbol, stopPrice, quantity, isLong) {
  try {
    const side = isLong ? 'SELL' : 'BUY';
    const timestamp = Date.now();
    
    const symbolInfo = await getSymbolInfo(symbol);
    if (!symbolInfo) throw new Error('Failed to get symbol info');
    
    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    if (!priceFilter) throw new Error('Price filter not found');
    
    const tickSize = priceFilter.tickSize;
    let validStopPrice = roundTickSize(stopPrice, tickSize);
    
    const tickerResponse = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
    const currentPrice = parseFloat(tickerResponse.data.price);
    
    if (isLong && validStopPrice >= currentPrice) {
      validStopPrice = roundTickSize(currentPrice - parseFloat(tickSize), tickSize);
    } else if (!isLong && validStopPrice <= currentPrice) {
      validStopPrice = roundTickSize(currentPrice + parseFloat(tickSize), tickSize);
    }
    
    const queryString = `symbol=${symbol}&side=${side}&type=STOP_MARKET&quantity=${quantity}&stopPrice=${validStopPrice}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;
    
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    return handleError(null, `Error setting stop loss for ${symbol}`, error, false);
  }
}

async function getCandles(symbol, interval = '4h', limit = 100) {
  try {
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return response.data.map(candle => ({
      time: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
    }));
  } catch (error) {
    return handleError(null, `Failed to fetch candles for ${symbol} (${interval})`, error, false);
  }
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
  try {
    return MACD.calculate({
      values: candles.map(c => c.close),
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
  } catch (error) {
    console.error('Error calculating MACD:', error);
    return [];
  }
}

function calculateBollingerBands(candles) {
  try {
    return BollingerBands.calculate({
      values: candles.map(c => c.close),
      period: 20,
      stdDev: 2
    });
  } catch (error) {
    console.error('Error calculating Bollinger Bands:', error);
    return [];
  }
}

function calculateIchimokuCloud(candles) {
  try {
    return IchimokuCloud.calculate({
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
      conversionPeriod: 9,
      basePeriod: 26,
      spanPeriod: 52,
      displacement: 26
    });
  } catch (error) {
    console.error('Error calculating Ichimoku Cloud:', error);
    return [];
  }
}

function calculateRSI(candles, period = 14) {
  try {
    return RSI.calculate({
      values: candles.map(c => c.close),
      period: period
    });
  } catch (error) {
    console.error('Error calculating RSI:', error);
    return [];
  }
}

function calculateMA(candles, period = 20) {
  try {
    return SMA.calculate({
      values: candles.map(c => c.close),
      period: period
    });
  } catch (error) {
    console.error('Error calculating MA:', error);
    return [];
  }
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

async function cancelAllOpenOrders(apiKey, secretKey, symbol) {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`; // Perbaikan typo
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`;
    const response = await axios.delete(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    return handleError(null, `Error canceling orders for ${symbol}`, error, false);
  }
}

async function monitorStopLoss(chatId, apiKey, secretKey) {
  try {
    const openPositions = await getBinanceOpenPositions(apiKey, secretKey);
    if (!openPositions || openPositions.length === 0) return;
  
    for (const position of openPositions) {
      const symbol = position.symbol;
      const entryPrice = parseFloat(position.entryPrice);
      const markPrice = parseFloat(position.markPrice);
      const leverage = parseFloat(position.leverage);
      const positionAmt = parseFloat(position.positionAmt);
      const isLong = positionAmt > 0;
      const quantity = Math.abs(positionAmt);
  
      const profitPercentage = isLong
        ? ((markPrice - entryPrice) / entryPrice) * leverage * 100
        : ((entryPrice - markPrice) / entryPrice) * leverage * 100;
  
      const key = `${chatId}_${symbol}`;
  
      if (!trailingStopLevels[key]) {
        trailingStopLevels[key] = isLong 
          ? entryPrice - (entryPrice / leverage)
          : entryPrice + (entryPrice / leverage);
      }
  
      if (isLong && markPrice <= trailingStopLevels[key]) {
        try {
          await setStopLossMarket(apiKey, secretKey, symbol, trailingStopLevels[key], quantity, isLong);
          const notif = `🚨 *Stop Loss Triggered*\n` +
            `*Symbol*: ${symbol}\n` +
            `*Entry Price*: $${entryPrice.toFixed(8)}\n` +
            `*Stop Loss Executed At*: $${trailingStopLevels[key].toFixed(8)}\n` +
            `*Current Price*: $${markPrice.toFixed(8)}\n` +
            `*Profit at Trigger*: ${profitPercentage.toFixed(2)}%`;
          await sendMessageWithRetry(chatId, notif, { parse_mode: 'Markdown' });
          delete trailingStopLevels[key];
        } catch (error) {
          await handleError(chatId, `Error triggering stop loss for ${symbol}`, error);
        }
        continue;
      } else if (!isLong && markPrice >= trailingStopLevels[key]) {
        try {
          await setStopLossMarket(apiKey, secretKey, symbol, trailingStopLevels[key], quantity, isLong);
          const notif = `🚨 *Stop Loss Triggered*\n` +
            `*Symbol*: ${symbol}\n` +
            `*Entry Price*: $${entryPrice.toFixed(8)}\n` +
            `*Stop Loss Executed At*: $${trailingStopLevels[key].toFixed(8)}\n` +
            `*Current Price*: $${markPrice.toFixed(8)}\n` +
            `*Profit at Trigger*: ${profitPercentage.toFixed(2)}%`;
          await sendMessageWithRetry(chatId, notif, { parse_mode: 'Markdown' });
          delete trailingStopLevels[key];
        } catch (error) {
          await handleError(chatId, `Error triggering stop loss for ${symbol}`, error);
        }
        continue;
      }
  
      let newPotentialStop;
      if (isLong) {
        newPotentialStop = markPrice - (entryPrice / leverage);
        if (newPotentialStop > trailingStopLevels[key]) {
          trailingStopLevels[key] = newPotentialStop;
          try {
            if (stopLossMessages[key]) await bot.deleteMessage(chatId, stopLossMessages[key]);
            const notif = `🛑 *Trailing Stop Loss Updated*\n` +
              `*Symbol*: ${symbol}\n` +
              `*Entry Price*: $${entryPrice.toFixed(8)}\n` +
              `*Current Price*: $${markPrice.toFixed(8)}\n` +
              `*Profit*: ${profitPercentage.toFixed(2)}%\n` +
              `*New Stop Loss Set At*: $${newPotentialStop.toFixed(8)}`;
            const sentMsg = await sendMessageWithRetry(chatId, notif, { parse_mode: 'Markdown' });
            stopLossMessages[key] = sentMsg.message_id;
          } catch (error) {
            await handleError(chatId, `Error updating trailing stop loss for ${symbol}`, error);
          }
        }
      } else {
        newPotentialStop = markPrice + (entryPrice / leverage);
        if (newPotentialStop < trailingStopLevels[key]) {
          trailingStopLevels[key] = newPotentialStop;
          try {
            if (stopLossMessages[key]) await bot.deleteMessage(chatId, stopLossMessages[key]);
            const notif = `🛑 *Trailing Stop Loss Updated*\n` +
              `*Symbol*: ${symbol}\n` +
              `*Entry Price*: $${entryPrice.toFixed(8)}\n` +
              `*Current Price*: $${markPrice.toFixed(8)}\n` +
              `*Profit*: ${profitPercentage.toFixed(2)}%\n` +
              `*New Stop Loss Set At*: $${newPotentialStop.toFixed(8)}`;
            const sentMsg = await sendMessageWithRetry(chatId, notif, { parse_mode: 'Markdown' });
            stopLossMessages[key] = sentMsg.message_id;
          } catch (error) {
            await handleError(chatId, `Error updating trailing stop loss for ${symbol}`, error);
          }
        }
      }
    }
  } catch (error) {
    await handleError(chatId, 'Error in stop loss monitoring', error);
  }
}

async function checkBalanceAndSearchCoin(chatId, apiKey, secretKey) {
  try {
    const balance = await getBinanceFuturesBalance(apiKey, secretKey);
    if (!balance) return;
  
    const usdtBalance = balance.find(asset => asset.asset === 'USDT');
    if (!usdtBalance) return;
  
    const totalBalance = parseFloat(usdtBalance.balance);
    const availableBalance = parseFloat(usdtBalance.availableBalance);
    const minimumBalance = totalBalance * 0.9;
  
    if (availableBalance >= minimumBalance) {
      await searchCoinWithIndicators(chatId, apiKey, secretKey);
    } else {
      console.log(`❌ Insufficient balance. Available must be above $${minimumBalance.toFixed(2)}`);
      setTimeout(() => checkBalanceAndSearchCoin(chatId, apiKey, secretKey), 5 * 60 * 1000);
    }
  } catch (error) {
    await handleError(chatId, 'Error checking balance', error);
  }
}

async function displayBalanceAndOrders(chatId, apiKey, secretKey) {
  try {
    let message = "";
    
    const balance = await getBinanceFuturesBalance(apiKey, secretKey);
    if (balance) {
      const usdtBalance = balance.find(asset => asset.asset === 'USDT');
      if (usdtBalance) {
        message += `💰 *Balance Summary* 💰\n\n` +
          `• Total: $${formatSmallNumber(parseFloat(usdtBalance.balance))}\n` +
          `• PNL: $${formatSmallNumber(parseFloat(usdtBalance.crossUnPnl))}\n` +
          `• Available: $${formatSmallNumber(parseFloat(usdtBalance.availableBalance))}\n\n`;
      }
    }
  
    const openPositions = await getBinanceOpenPositions(apiKey, secretKey);
    message += `📋 *Open Positions* 📋\n\n`;
    
    if (openPositions && openPositions.length > 0) {
      openPositions.forEach(position => {
        const pair = position.symbol;
        const entryPrice = parseFloat(position.entryPrice);
        const markPrice = parseFloat(position.markPrice);
        const unrealizedProfit = parseFloat(position.unRealizedProfit);
        const margin = parseFloat(position.positionAmt);
        const leverage = parseFloat(position.leverage);
        const liquidationPrice = parseFloat(position.liquidationPrice);
        const profitPercentage = margin > 0
          ? ((markPrice - entryPrice) / entryPrice) * leverage * 100
          : ((entryPrice - markPrice) / entryPrice) * leverage * 100;
  
        message += `📌 *${pair}*\n` +
          `• Entry: $${formatSmallNumber(entryPrice)}\n` +
          `• Current: $${formatSmallNumber(markPrice)}\n` +
          `• Margin: $${formatSmallNumber(margin)}\n` +
          `• Leverage: ${leverage}x\n` +
          `• PNL: $${formatSmallNumber(unrealizedProfit)}\n` +
          `• Profit: ${profitPercentage.toFixed(2)}%\n` +
          `• Liq. Price: $${formatSmallNumber(liquidationPrice)}\n\n`;
      });
    } else {
      message += "No open positions found.\n";
    }
  
    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: '/refresh_balance_orders' }]
      ]
    };

    const sentMsg = await sendMessageWithRetry(chatId, message, { 
      parse_mode: 'Markdown', 
      reply_markup: inlineKeyboard 
    });
    return sentMsg;
  } catch (error) {
    await handleError(chatId, 'Error displaying balance', error);
    return null;
  }
}

// Perbaikan: Efisiensi dengan paralelisme dan modularitas
async function searchCoinWithIndicators(chatId, apiKey, secretKey) {
  if (isSearching) return;
  isSearching = true;
  try {
    const mappingKeys = Object.keys(cryptoMapping);
    if (!mappingKeys.length) throw new Error('Crypto mapping is empty');
    const symbols = mappingKeys.map(key => key.toUpperCase() + 'USDT');

    // Hapus pesan sebelumnya
    if (searchNotificationMessages[chatId]) {
      try {
        await bot.deleteMessage(chatId, searchNotificationMessages[chatId]);
      } catch (e) {
        if (!e.message.includes('message to delete not found')) console.error("Error deleting message:", e.message);
      }
      delete searchNotificationMessages[chatId];
    }
    Object.keys(searchCoinMessages).forEach(key => delete searchCoinMessages[key]);

    const results = [];
    const timeFrames = ['1h', '4h', '1d', '3d', '1w'];

    // Paralelkan pemrosesan simbol
    await Promise.all(symbols.map(async (symbol) => {
      if (!symbol.endsWith('USDT') || BLACKLIST.includes(symbol)) return;

      const symbolResults = await Promise.all(timeFrames.map(async (timeFrame) => {
        try {
          const candles = await getCandles(symbol, timeFrame);
          if (!candles || candles.length === 0) return null;

          const { supportLevels, resistanceLevels } = calculateSupportResistance(candles);
          const indicators = await calculateIndicators(candles);
          if (!indicators) return null;

          const { lastMACD, lastBB, lastRSI, lastSMA, lastCandle } = indicators;

          if (isLongSupport(lastMACD, lastBB, lastRSI, lastSMA, lastCandle, supportLevels)) {
            return { symbol, timeFrame, action: 'long (support)', lastPrice: lastCandle.close };
          }
          if (isShortBreakout(lastMACD, lastBB, lastRSI, lastSMA, lastCandle, resistanceLevels)) {
            return { symbol, timeFrame, action: 'long (breakout)', lastPrice: lastCandle.close };
          }
          return null;
        } catch (error) {
          console.error(`Error processing ${symbol} ${timeFrame}:`, error.message);
          return null;
        }
      }));

      results.push(...symbolResults.filter(result => result !== null));
    }));

    for (const result of results) {
      const currentOpenPositions = await getBinanceOpenPositions(apiKey, secretKey);
      const hasOpenPosition = currentOpenPositions?.some(p => p.symbol === result.symbol && parseFloat(p.positionAmt) !== 0);
      if (hasOpenPosition) {
        console.log(`Already have position for ${result.symbol}`);
        continue;
      }

      if (processingCoins[result.symbol]) continue;
      processingCoins[result.symbol] = true;

      const coinMsg = `✅ *Potential Coin Found:*\n` +
        `- ${result.symbol} (${result.action}) @ $${result.lastPrice} (Time Frame: ${result.timeFrame})`;

      if (searchCoinMessages[result.symbol]) {
        await bot.editMessageText(coinMsg, {
          chat_id: chatId,
          message_id: searchCoinMessages[result.symbol],
          parse_mode: 'Markdown'
        });
      } else {
        const sent = await sendMessageWithRetry(chatId, coinMsg, { parse_mode: 'Markdown' });
        searchCoinMessages[result.symbol] = sent.message_id;
      }

      try {
        const balance = await getBinanceFuturesBalance(apiKey, secretKey);
        const usdtBalance = balance?.find(asset => asset.asset === 'USDT');
        if (!usdtBalance) throw new Error('USDT balance not found');

        const totalBalance = parseFloat(usdtBalance.balance);
        const availableBalance = parseFloat(usdtBalance.availableBalance);
        const minimumBalance = totalBalance * 0.9;

        if (availableBalance < minimumBalance) {
          const balMsg = `❌ Need at least $${minimumBalance.toFixed(2)} available`;
          if (searchCoinMessages[result.symbol]) {
            await bot.deleteMessage(chatId, searchCoinMessages[result.symbol]);
            delete searchCoinMessages[result.symbol];
          }
          const sentBalMsg = await sendMessageWithRetry(chatId, balMsg, { parse_mode: 'Markdown' });
          searchCoinMessages[result.symbol] = sentBalMsg.message_id;
          processingCoins[result.symbol] = false;
          setTimeout(() => checkBalanceAndSearchCoin(chatId, apiKey, secretKey), 5 * 60 * 1000);
          continue;
        }

        const symbolInfo = await getSymbolInfo(result.symbol);
        if (!symbolInfo) throw new Error(`No info for ${result.symbol}`);

        const stepSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize;
        const maxLeverage = await getMaxLeverage(apiKey, secretKey, result.symbol);
        if (!maxLeverage) throw new Error(`No leverage for ${result.symbol} or below ${MIN_LEVERAGE}x`);

        await setLeverage(apiKey, secretKey, result.symbol, maxLeverage);
        const margin = totalBalance * 20;
        const quantity = margin / result.lastPrice;
        const roundedQuantity = roundStepSize(quantity, stepSize);

        if (result.action === 'long (support)') {
          await openLongPositionMarket(chatId, apiKey, secretKey, result.symbol, roundedQuantity, result.timeFrame);
        } else if (result.action === 'long (breakout)') {
          await openShortPositionMarket(chatId, apiKey, secretKey, result.symbol, roundedQuantity, result.timeFrame);
        }
        await checkBalanceAndSearchCoin(chatId, apiKey, secretKey);
        await new Promise(resolve => setTimeout(resolve, 60000));
      } catch (error) {
        await handleError(chatId, `Error processing ${result.symbol}`, error);
      }
      processingCoins[result.symbol] = false;
    }
  } catch (error) {
    await handleError(chatId, 'Error searching coins', error);
  } finally {
    isSearching = false;
  }
}

// Helper untuk indikator
async function calculateIndicators(candles) {
  try {
    const macd = calculateMACD(candles);
    const bb = calculateBollingerBands(candles);
    const rsi = calculateRSI(candles, 7);
    const sma20 = calculateMA(candles, 20);
    if (!macd.length || !bb.length || !rsi.length || !sma20.length) return null;

    return {
      lastMACD: macd[macd.length - 1],
      lastBB: bb[bb.length - 1],
      lastRSI: rsi[rsi.length - 1],
      lastSMA: sma20[sma20.length - 1],
      lastCandle: candles[candles.length - 1]
    };
  } catch (error) {
    console.error('Error calculating indicators:', error);
    return null;
  }
}

// Helper untuk kondisi trading
function isLongSupport(lastMACD, lastBB, lastRSI, lastSMA, lastCandle, supportLevels) {
  return (
    (lastMACD?.histogram > 0 && lastCandle.close < lastBB.lower && lastRSI < 30 && lastCandle.close < lastSMA &&
      lastCandle.close >= supportLevels[0] * 0.99 && lastCandle.close <= supportLevels[0] * 1.01) ||
    isBounceFromSupport(lastCandle, supportLevels[0])
  );
}

function isShortBreakout(lastMACD, lastBB, lastRSI, lastSMA, lastCandle, resistanceLevels) {
  return (
    (lastMACD?.histogram > 0 && lastCandle.close > lastBB.upper && lastRSI > 70 && lastCandle.close > lastSMA) ||
    isBounceFromResistance(lastCandle, resistanceLevels[0])
  );
}

// Perbaikan: Pemanfaatan data real-time
async function triggerRealTimeTrade(symbol, currentPrice) {
  for (const chatId in userApiKeys) {
    const { apiKey, secretKey } = userApiKeys[chatId];
    if (processingCoins[symbol] || BLACKLIST.includes(symbol)) continue;

    try {
      const candles = await getCandles(symbol, '1h', 50);
      if (!candles) continue;

      const { supportLevels, resistanceLevels } = calculateSupportResistance(candles);
      const indicators = await calculateIndicators(candles);
      if (!indicators) continue;

      const { lastMACD, lastBB, lastRSI, lastSMA } = indicators;

      if (isLongSupport(lastMACD, lastBB, lastRSI, lastSMA, { close: currentPrice }, supportLevels)) {
        await executeTrade(chatId, apiKey, secretKey, symbol, 'long (support)', currentPrice, '1h');
      } else if (isShortBreakout(lastMACD, lastBB, lastRSI, lastSMA, { close: currentPrice }, resistanceLevels)) {
        await executeTrade(chatId, apiKey, secretKey, symbol, 'long (breakout)', currentPrice, '1h');
      }
    } catch (error) {
      await handleError(chatId, `Error in real-time trade check for ${symbol}`, error);
    }
  }
}

async function executeTrade(chatId, apiKey, secretKey, symbol, action, price, timeFrame) {
  try {
    processingCoins[symbol] = true;
    const symbolInfo = await getSymbolInfo(symbol);
    if (!symbolInfo) throw new Error('Failed to get symbol info');

    const stepSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize;
    const maxLeverage = await getMaxLeverage(apiKey, secretKey, symbol);
    if (!maxLeverage) throw new Error(`Leverage below ${MIN_LEVERAGE}x`);

    await setLeverage(apiKey, secretKey, symbol, maxLeverage);
    const balance = await getBinanceFuturesBalance(apiKey, secretKey);
    const usdtBalance = balance?.find(asset => asset.asset === 'USDT');
    if (!usdtBalance || parseFloat(usdtBalance.availableBalance) < parseFloat(usdtBalance.balance) * 0.9) {
      throw new Error('Insufficient balance');
    }

    const margin = parseFloat(usdtBalance.balance) * 20;
    const quantity = roundStepSize(margin / price, stepSize);

    if (action === 'long (support)') {
      await openLongPositionMarket(chatId, apiKey, secretKey, symbol, quantity, timeFrame);
    } else if (action === 'long (breakout)') {
      await openShortPositionMarket(chatId, apiKey, secretKey, symbol, quantity, timeFrame);
    }
  } catch (error) {
    await handleError(chatId, `Failed to execute trade for ${symbol}`, error);
  } finally {
    processingCoins[symbol] = false;
  }
}

bot.onText(/\/setapi (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const apiKey = match[1];
  const secretKey = match[2];
  
  userApiKeys[chatId] = { apiKey, secretKey };
  saveUserApiKeys();
  
  try {
    await bot.sendMessage(chatId, '✅ API keys saved successfully');
    
    if (userIntervals[chatId]) {
      clearInterval(userIntervals[chatId].searchInterval);
      clearInterval(userIntervals[chatId].monitorInterval);
    }
  
    const searchInterval = setInterval(async () => {
      if (!isSearching) await checkBalanceAndSearchCoin(chatId, apiKey, secretKey);
    }, 5 * 60 * 1000);
    const monitorInterval = setInterval(() => monitorStopLoss(chatId, apiKey, secretKey), 60 * 1000);
    
    userIntervals[chatId] = { searchInterval, monitorInterval };
    await checkBalanceAndSearchCoin(chatId, apiKey, secretKey);
    
    const sentMsg = await displayBalanceAndOrders(chatId, apiKey, secretKey);
    if (sentMsg) balanceOrdersMessages[chatId] = sentMsg.message_id;
    
  } catch (error) {
    await handleError(chatId, 'Error setting API', error);
  }
});

bot.onText(/\/fclose (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(chatId, '❌ Perintah ini hanya dapat digunakan di chat pribadi.');
    return;
  }
  
  const userKeys = userApiKeys[chatId];
  if (!userKeys) {
    await bot.sendMessage(chatId, '❌ Anda harus mengatur API key terlebih dahulu dengan /setapi');
    return;
  }
  
  const closeTarget = match[1].toUpperCase();
  
  try {
    const openPositions = await getBinanceOpenPositions(userKeys.apiKey, userKeys.secretKey);
    if (!openPositions || openPositions.length === 0) {
      await bot.sendMessage(chatId, '❌ Tidak ada posisi terbuka.');
      return;
    }
  
    let positionsToClose = openPositions;
  
    if (closeTarget !== 'ALL') {
      positionsToClose = openPositions.filter(pos => pos.symbol === closeTarget);
      if (positionsToClose.length === 0) {
        await bot.sendMessage(chatId, `❌ Tidak ada posisi terbuka untuk ${closeTarget}`);
        return;
      }
    }
  
    for (const position of positionsToClose) {
      const symbol = position.symbol;
      const quantity = Math.abs(parseFloat(position.positionAmt));
      const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';
  
      try {
        const timestamp = Date.now();
        const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`; // Perbaikan typo
        const signature = crypto.createHmac('sha256', userKeys.secretKey).update(queryString).digest('hex');
        const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;
        
        await axios.post(url, null, { headers: { 'X-MBX-APIKEY': userKeys.apiKey } });
        await bot.sendMessage(chatId, `✅ Posisi ${symbol} berhasil ditutup.`);
      } catch (error) {
        await handleError(chatId, `Error closing ${symbol}`, error);
      }
    }
  } catch (error) {
    await handleError(chatId, 'Error closing positions', error);
  }
});

bot.on('callback_query', async (callbackQuery) => {
  await bot.answerCallbackQuery(callbackQuery.id);
  const chatId = callbackQuery.message.chat.id;
  const userKeys = userApiKeys[chatId];
  
  if (!userKeys) {
    await bot.sendMessage(chatId, '❌ Set API keys first with /setapi');
    return;
  }
  
  if (callbackQuery.data === '/refresh_balance_orders') {
    try {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      const sentMsg = await displayBalanceAndOrders(chatId, userKeys.apiKey, userKeys.secretKey);
      if (sentMsg) balanceOrdersMessages[chatId] = sentMsg.message_id;
    } catch (e) {
      await handleError(chatId, 'Error refreshing balance/orders', e);
    }
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text.startsWith('/setapi') && !msg.text.startsWith('/fclose')) {
    await bot.sendMessage(chatId, 
      'Available commands:\n' +
      '- /setapi <api_key> <secret_key>\n' +
      '- /fclose'
    );
  }
});

// Initialize for existing users
for (const chatId in userApiKeys) {
  const { apiKey, secretKey } = userApiKeys[chatId];
  if (!userIntervals[chatId]) {
    userIntervals[chatId] = {
      searchInterval: setInterval(async () => {
        if (!isSearching) await checkBalanceAndSearchCoin(chatId, apiKey, secretKey);
      }, 5 * 60 * 1000),
      monitorInterval: setInterval(() => monitorStopLoss(chatId, apiKey, secretKey), 60 * 1000)
    };
  }
  checkBalanceAndSearchCoin(chatId, apiKey, secretKey);
  displayBalanceAndOrders(chatId, apiKey, secretKey).then(sentMsg => {
    if (sentMsg) balanceOrdersMessages[chatId] = sentMsg.message_id;
  });
}
