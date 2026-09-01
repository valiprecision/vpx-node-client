#!/usr/bin/env node
/**
 * oracle-node.js — VPX Oracle Main Daemon
 * AXIOLEDGER · valiprecision ($VPX)
 *
 * Cron: every 60 seconds
 * Fetches ETH/USD, BTC/USD, AXQ/USD and pushes on-chain when conditions met.
 */

'use strict';

require('dotenv').config();

const cron   = require('node-cron');
const logger = require('./utils/logger');
const { fetchAggregatedPrice } = require('./feeds/price-feed');
const { maybePushPrice }       = require('./feeds/on-chain-pusher');

const VERSION = '1.0.0';

// ── Symbols to track ──────────────────────────────────────────────────────────
// AXQ: mock price until listed on CEX
const SYMBOLS = ['ETH', 'BTC', 'AXQ'];

const AXQ_MOCK_PRICE = parseFloat(process.env.AXQ_MOCK_PRICE || '0.015'); // $0.015 default

// ── Price fetch + push cycle ─────────────────────────────────────────────────

async function runCycle() {
  logger.info('oracle cycle start', { symbols: SYMBOLS });

  for (const symbol of SYMBOLS) {
    try {
      let result;

      if (symbol === 'AXQ') {
        // AXQ not listed on CEX yet — use mock price from env
        result = {
          price: AXQ_MOCK_PRICE,
          sources: [{ source: 'mock-env', price: AXQ_MOCK_PRICE, error: null }],
          deviation: 0,
          timestamp: Date.now(),
          reliable: true,
        };
        logger.debug('AXQ mock price used', { price: AXQ_MOCK_PRICE });
      } else {
        result = await fetchAggregatedPrice(symbol);
      }

      logger.info('price fetched', {
        symbol,
        price: result.price,
        deviation: result.deviation,
        reliable: result.reliable,
        sources: result.sources.map(s => ({ name: s.source, ok: s.error === null })),
      });

      if (result.price) {
        const pushResult = await maybePushPrice(symbol, result.price, result.timestamp, result.reliable);
        if (pushResult.pushed) {
          logger.info('push confirmed', { symbol, txHash: pushResult.txHash });
        } else {
          logger.debug('push skipped', { symbol, reason: pushResult.reason });
        }
      } else {
        logger.warn('no valid price — all sources failed', { symbol });
      }

    } catch (err) {
      logger.error('unhandled error in cycle', { symbol, error: err.message, stack: err.stack });
    }
  }

  logger.info('oracle cycle complete');
}

// ── Startup ───────────────────────────────────────────────────────────────────

logger.info('vpx oracle node starting', {
  version: VERSION,
  rpcUrl: process.env.RPC_URL ? '[set]' : '[NOT SET]',
  contract: process.env.VPX_ORACLE_CONTRACT ? '[set]' : '[NOT SET]',
  dryRun: !process.env.ORACLE_PRIVATE_KEY,
});

// Run immediately on startup, then every 60 seconds
runCycle().catch(err => logger.error('startup cycle failed', { error: err.message }));

const job = cron.schedule('*/60 * * * * *', () => {
  runCycle().catch(err => logger.error('cron cycle failed', { error: err.message }));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`received ${signal} — shutting down gracefully`);
  job.stop();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
