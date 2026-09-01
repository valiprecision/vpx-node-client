'use strict';
/**
 * price-feed.test.js — Unit tests for VPX Oracle price aggregator
 * All HTTP calls are mocked — no real network in CI.
 */

jest.mock('axios');
const axios = require('axios');

const { fetchAggregatedPrice } = require('../feeds/price-feed');

describe('fetchAggregatedPrice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns median price from 2+ valid sources', async () => {
    // Binance: 3000, CoinGecko: 3010, Kraken: 2990 — deviation ≈ 0.33% → reliable
    axios.get.mockImplementation((url) => {
      if (url.includes('binance'))   return Promise.resolve({ data: { price: '3000.00' } });
      if (url.includes('coingecko')) return Promise.resolve({ data: { ethereum: { usd: 3010 } } });
      if (url.includes('kraken'))    return Promise.resolve({ data: { result: { XETHZUSD: { c: ['2990.00'] } } } });
      return Promise.reject(new Error('unknown source'));
    });

    const result = await fetchAggregatedPrice('ETH');

    expect(result.price).toBeCloseTo(3000, 0);
    expect(result.reliable).toBe(true);
    expect(result.sources.length).toBe(3);
  });

  it('still returns price with only 1 valid source (not reliable)', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('binance')) return Promise.resolve({ data: { price: '50000.00' } });
      return Promise.reject(new Error('timeout'));
    });

    const result = await fetchAggregatedPrice('BTC');

    expect(result.price).toBeCloseTo(50000, 0);
    expect(result.reliable).toBe(false); // only 1 source → below min 2
  });

  it('returns null price when all sources fail', async () => {
    axios.get.mockRejectedValue(new Error('network error'));

    const result = await fetchAggregatedPrice('ETH');

    expect(result.price).toBeNull();
    expect(result.reliable).toBe(false);
  });

  it('flags unreliable when deviation > 2%', async () => {
    // 3000 vs 3200 — median=3100, maxDev=6.45% → unreliable
    axios.get.mockImplementation((url) => {
      if (url.includes('binance'))   return Promise.resolve({ data: { price: '3000.00' } });
      if (url.includes('coingecko')) return Promise.resolve({ data: { ethereum: { usd: 3200 } } });
      return Promise.reject(new Error('timeout'));
    });

    const result = await fetchAggregatedPrice('ETH');

    expect(result.reliable).toBe(false);
    expect(result.deviation).toBeGreaterThan(2);
  });

  it('handles AXQ mock price (kraken unsupported)', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('binance'))   return Promise.resolve({ data: { price: '0.015' } });
      if (url.includes('coingecko')) return Promise.resolve({ data: { axioledger: { usd: 0.0151 } } });
      return Promise.reject(new Error('timeout'));
    });

    const result = await fetchAggregatedPrice('AXQ');

    expect(result.price).toBeGreaterThan(0);
    expect(result.sources.find(s => s.source === 'kraken')?.error).toBe('unsupported symbol');
  });
});
