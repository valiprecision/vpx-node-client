#!/usr/bin/env node
/**
 * on-chain-pusher.js — VPX Oracle On-Chain Price Pusher
 * AXIOLEDGER · valiprecision ($VPX)
 *
 * Pushes aggregated price to VPXOracleFeed contract.
 * Push conditions:
 *   - Price changed > 0.1% since last push, OR
 *   - More than 5 minutes since last push (heartbeat)
 */

'use strict';

const { ethers } = require('ethers');
const logger = require('../utils/logger');

// ── ABI (minimal — only functions we call) ────────────────────────────────────
const VPX_ORACLE_ABI = [
  'function updatePrice(bytes32 asset, uint256 price, uint256 timestamp) external',
  'function getLatestPrice(bytes32 asset) external view returns (uint256 price, uint256 timestamp, uint256 roundId)',
  'event PriceUpdated(bytes32 indexed asset, uint256 price, uint256 roundId)',
];

// ── Config ────────────────────────────────────────────────────────────────────
const PRICE_CHANGE_THRESHOLD = 0.001; // 0.1%
const HEARTBEAT_INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ── State (last push tracking) ────────────────────────────────────────────────
const lastPushState = new Map(); // asset → { price, timestamp }

// ── Provider & contract factory ───────────────────────────────────────────────
let _provider = null;
let _wallet   = null;
let _contract = null;

function getContract() {
  if (_contract) return _contract;

  const rpcUrl      = process.env.RPC_URL;
  const privateKey  = process.env.ORACLE_PRIVATE_KEY;
  const contractAddr = process.env.VPX_ORACLE_CONTRACT;

  if (!rpcUrl || !privateKey || !contractAddr) {
    throw new Error('Missing env: RPC_URL, ORACLE_PRIVATE_KEY, or VPX_ORACLE_CONTRACT');
  }

  _provider = new ethers.JsonRpcProvider(rpcUrl);
  _wallet   = new ethers.Wallet(privateKey, _provider);
  _contract = new ethers.Contract(contractAddr, VPX_ORACLE_ABI, _wallet);
  return _contract;
}

// ── Push logic ────────────────────────────────────────────────────────────────

function shouldPush(assetKey, newPrice) {
  const last = lastPushState.get(assetKey);
  if (!last) return true; // Never pushed

  const now = Date.now();
  const priceChange = Math.abs(newPrice - last.price) / last.price;
  const timeSincePush = now - last.timestamp;

  if (priceChange > PRICE_CHANGE_THRESHOLD) return true;
  if (timeSincePush > HEARTBEAT_INTERVAL_MS) return true;
  return false;
}

async function pushWithRetry(contract, assetBytes32, priceBigInt, timestampSec, attempt = 1) {
  try {
    const gasEstimate = await contract.updatePrice.estimateGas(assetBytes32, priceBigInt, timestampSec);
    const tx = await contract.updatePrice(assetBytes32, priceBigInt, timestampSec, {
      gasLimit: (gasEstimate * 120n) / 100n, // 20% buffer
    });
    const receipt = await tx.wait(1);
    return receipt;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      logger.warn(`push retry ${attempt}/${MAX_RETRIES}`, { error: err.message });
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return pushWithRetry(contract, assetBytes32, priceBigInt, timestampSec, attempt + 1);
    }
    throw err;
  }
}

/**
 * Push price on-chain if conditions are met.
 * @param {string} symbol  - 'ETH', 'BTC', 'AXQ'
 * @param {number} price   - USD price
 * @param {number} timestamp - Unix ms from aggregator
 * @param {boolean} reliable - From aggregator
 */
async function maybePushPrice(symbol, price, timestamp, reliable) {
  if (!reliable) {
    logger.warn('skipping unreliable price', { symbol, price });
    return { pushed: false, reason: 'unreliable' };
  }

  const assetKey = symbol;
  if (!shouldPush(assetKey, price)) {
    return { pushed: false, reason: 'below threshold and within heartbeat' };
  }

  const contract = getContract();
  // Encode symbol as bytes32
  const assetBytes32 = ethers.encodeBytes32String(symbol);
  // Price in 18 decimal fixed-point
  const priceBigInt  = BigInt(Math.round(price * 1e18));
  const timestampSec = BigInt(Math.floor(timestamp / 1000));

  try {
    const receipt = await pushWithRetry(contract, assetBytes32, priceBigInt, timestampSec);
    lastPushState.set(assetKey, { price, timestamp: Date.now() });

    logger.info('price pushed on-chain', {
      symbol,
      price,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });

    return { pushed: true, txHash: receipt.hash };
  } catch (err) {
    logger.error('failed to push price after retries', { symbol, price, error: err.message });
    return { pushed: false, reason: err.message };
  }
}

module.exports = { maybePushPrice };
