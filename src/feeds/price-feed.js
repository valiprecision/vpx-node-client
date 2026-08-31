#!/usr/bin/env node
/**
 * price-feed.js — VPX Oracle Price Aggregator
 * AXIOLEDGER · valiprecision ($VPX)
 *
 * Pulls price from 3 independent sources, aggregates by median.
 * Median is manipulation-resistant: attacker must corrupt >50% of sources.
 */

'use strict';

const axios = require('axios');

// ── Source definitions ────────────────────────────────────────────────────────

const SOURCES = {
  binance: {
    name: 'binance',
    url: (symbol) => `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`,
    parse: (data) => parseFloat(data.price),
    timeout: 5000,
  },
  coingecko: {
    name: 'coingecko',
    // symbol map: ETH→ethereum, BTC→bitcoin
    url: (symbol) => {
      const id = { ETH: 'ethereum', BTC: 'bitcoin', AXQ: 'axioledger' }[symbol] || symbol.toLowerCase();
      return `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    },
    parse: (data, symbol) => {
      const id = { ETH: 'ethereum', BTC: 'bitcoin', AXQ: 'axioledger' }[symbol] || symbol.toLowerCase();
      return parseFloat(data[id]?.usd);
    },
    timeout: 8000,
  },
  kraken: {
    name: 'kraken',
    url: (symbol) => {
      const pair = { ETH: 'ETHUSD', BTC: 'XBTUSD', AXQ: null }[symbol];
      if (!pair) return null;
      return `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
    },
    parse: (data, symbol) => {
      const pair = { ETH: 'XETHZUSD', BTC: 'XXBTZUSD' }[symbol];
      if (!pair) return null;
      const result = data.result?.[pair];
      return result ? parseFloat(result.c[0]) : null;
    },
    timeout: 6000,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function deviationPercent(values) {
  if (values.length < 2) return 0;
  const med = median(values);
  const maxDev = Math.max(...values.map(v => Math.abs(v - med) / med * 100));
  return maxDev;
}

async function fetchFromSource(sourceName, symbol) {
  const source = SOURCES[sourceName];
  const url = source.url(symbol);
  if (!url) return { source: sourceName, price: null, error: 'unsupported symbol' };

  try {
    const res = await axios.get(url, {
      timeout: source.timeout,
      headers: { 'User-Agent': 'VPX-Oracle-Node/1.0' },
    });
    const price = source.parse(res.data, symbol);
    if (!price || isNaN(price) || price <= 0) throw new Error('invalid price response');
    return { source: sourceName, price, error: null };
  } catch (err) {
    return { source: sourceName, price: null, error: err.message };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch aggregated price for a symbol.
 * @param {string} symbol - e.g. 'ETH', 'BTC', 'AXQ'
 * @returns {{ price: number, sources: object[], deviation: number, timestamp: number, reliable: boolean }}
 */
async function fetchAggregatedPrice(symbol) {
  const results = await Promise.allSettled(
    Object.keys(SOURCES).map(name => fetchFromSource(name, symbol))
  );

  const sources = results.map(r => r.status === 'fulfilled' ? r.value : { source: '?', price: null, error: r.reason?.message });
  const validPrices = sources.filter(s => s.price !== null && s.price > 0);

  if (validPrices.length === 0) {
    return { price: null, sources, deviation: null, timestamp: Date.now(), reliable: false };
  }

  const prices = validPrices.map(s => s.price);
  const aggregatedPrice = median(prices);
  const deviation = deviationPercent(prices);

  // Flag as unreliable if deviation between sources > 2%
  const DEVIATION_THRESHOLD = 2.0;
  const reliable = validPrices.length >= 2 && deviation <= DEVIATION_THRESHOLD;

  return {
    price: aggregatedPrice,
    sources,
    deviation: parseFloat(deviation.toFixed(4)),
    timestamp: Date.now(),
    reliable,
  };
}

module.exports = { fetchAggregatedPrice };
