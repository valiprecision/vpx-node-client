'use strict';
/**
 * on-chain-pusher.test.js — Unit tests for VPX Oracle on-chain pusher
 * ethers is mocked — no real RPC in CI.
 *
 * The on-chain-pusher module caches its contract singleton (_contract), so we
 * load the module once per test suite with env pre-set and only reset the
 * updatePrice mock implementation between tests (NOT the Contract mock).
 */

// ── Module-level mock setup (jest.mock is hoisted before any imports) ─────────
jest.mock('ethers', () => {
  const updatePriceFn = jest.fn();
  updatePriceFn.estimateGas = jest.fn();
  const contractInstance = { updatePrice: updatePriceFn };

  // on-chain-pusher.js uses: const { ethers } = require('ethers')
  // so we must export a top-level `ethers` key
  const ethersMock = {
    JsonRpcProvider:     jest.fn().mockReturnValue({}),
    Wallet:              jest.fn().mockReturnValue({}),
    Contract:            jest.fn().mockReturnValue(contractInstance),
    encodeBytes32String: jest.fn((s) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`),
  };

  return {
    ethers:        ethersMock,
    // Exposed for test access via jest.requireMock('ethers').__updatePrice
    __updatePrice: updatePriceFn,
    __contract:    contractInstance,
  };
});

// Env must be set before requiring the module so the singleton initialises correctly
process.env.RPC_URL             = 'http://localhost:8545';
process.env.ORACLE_PRIVATE_KEY  = '0x' + 'a'.repeat(64);
process.env.VPX_ORACLE_CONTRACT = '0x' + '0'.repeat(40);

const { maybePushPrice } = require('../feeds/on-chain-pusher');

// ── Test helpers ──────────────────────────────────────────────────────────────
function getUpdatePriceMock() {
  return jest.requireMock('ethers').__updatePrice;
}

function mockSuccessfulPush(hash = '0xabc123') {
  const fn = getUpdatePriceMock();
  fn.estimateGas.mockResolvedValue(50000n);
  fn.mockResolvedValue({
    wait: jest.fn().mockResolvedValue({ hash, blockNumber: 42, gasUsed: 50000n }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('maybePushPrice', () => {
  beforeEach(() => {
    // Only reset the implementation — NOT mockReset (which would also reset estimateGas)
    getUpdatePriceMock().mockClear();
    getUpdatePriceMock().estimateGas.mockClear();
    mockSuccessfulPush();
  });

  it('pushes price on first call for a new symbol', async () => {
    mockSuccessfulPush('0xhash_first');

    const result = await maybePushPrice('SYMTEST_A', 3000, Date.now(), true);

    expect(result.pushed).toBe(true);
    expect(result.txHash).toBe('0xhash_first');
    expect(getUpdatePriceMock()).toHaveBeenCalledTimes(1);
  });

  it('skips push when price is unreliable', async () => {
    const result = await maybePushPrice('SYMTEST_B', 3000, Date.now(), false);

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('unreliable');
    expect(getUpdatePriceMock()).not.toHaveBeenCalled();
  });

  it('skips push when price change is below 0.1% threshold within heartbeat', async () => {
    // First push to record state for SYMTEST_C
    mockSuccessfulPush('0xhash_c1');
    await maybePushPrice('SYMTEST_C', 1.0000, Date.now(), true);

    getUpdatePriceMock().mockClear();
    getUpdatePriceMock().estimateGas.mockClear();

    // Change = 0.0001% — below 0.1% threshold
    const result = await maybePushPrice('SYMTEST_C', 1.0000001, Date.now(), true);

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('below threshold and within heartbeat');
    expect(getUpdatePriceMock()).not.toHaveBeenCalled();
  });

  it('pushes again when price change exceeds 0.1% threshold', async () => {
    // First push for SYMTEST_D
    mockSuccessfulPush('0xhash_d1');
    await maybePushPrice('SYMTEST_D', 3000, Date.now() - 1000, true);

    getUpdatePriceMock().mockClear();
    getUpdatePriceMock().estimateGas.mockClear();
    mockSuccessfulPush('0xhash_d2');

    // 3000 → 3031 = +1.03% > 0.1% → must push
    const result = await maybePushPrice('SYMTEST_D', 3031, Date.now(), true);

    expect(result.pushed).toBe(true);
    expect(result.txHash).toBe('0xhash_d2');
    expect(getUpdatePriceMock()).toHaveBeenCalledTimes(1);
  });
});
