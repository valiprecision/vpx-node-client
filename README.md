# vpx-node-client — VPX Oracle Price Feed Node

**AXIOLEDGER `valiprecision` ($VPX) — Off-chain Oracle Infrastructure**

Aggregates prices from multiple CEX sources and pushes to `VPXOracleFeed` on-chain.

---

## Architecture

```
Binance REST ─┐
CoinGecko REST─┼─► median() ─► shouldPush()? ─► VPXOracleFeed.updatePrice()
Kraken REST  ─┘                   (0.1% / 5min)        (on-chain)
                                                          │
                                               KPXRouterGateway.getLatestPrice()
```

**Manipulation resistance:** Median aggregation — attacker must corrupt >50% of sources.

**Staleness protection:** `getLatestPrice()` reverts if data >10 minutes old.

---

## Setup

```bash
cp .env.example .env
# Fill: RPC_URL, ORACLE_PRIVATE_KEY, VPX_ORACLE_CONTRACT

npm install
npm start
```

**Dev mode (auto-restart):**
```bash
npm run dev
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | ✅ | EVM RPC endpoint (Sepolia or mainnet) |
| `ORACLE_PRIVATE_KEY` | ✅ | Oracle node wallet private key |
| `VPX_ORACLE_CONTRACT` | ✅ | Deployed `VPXOracleFeed` address |
| `AXQ_MOCK_PRICE` | | AXQ mock price in USD (default: 0.015) |
| `LOG_LEVEL` | | `debug`/`info`/`warn`/`error` (default: info) |

---

## Supported Assets

| Symbol | Binance | CoinGecko | Kraken | Notes |
|---|---|---|---|---|
| ETH | ✅ | ✅ | ✅ | |
| BTC | ✅ | ✅ | ✅ | |
| AXQ | ❌ | ❌ | ❌ | Mock price from env until CEX listing |

---

## Smart Contract: VPXOracleFeed

Deploy via `contracts/VPXOracleFeed.sol` (requires OpenZeppelin):

```bash
# With Foundry
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge create contracts/VPXOracleFeed.sol:VPXOracleFeed \
  --constructor-args $ADMIN_ADDRESS \
  --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY

# Grant ORACLE_ROLE to node wallet
cast send $CONTRACT "addOracleNode(address)" $ORACLE_NODE_ADDRESS \
  --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
```

---

## Push conditions

A price update is sent on-chain when **either**:
1. Price changed **> 0.1%** since last push
2. **> 5 minutes** have elapsed since last push (heartbeat)

Unreliable prices (source deviation > 2% or < 2 valid sources) are skipped.
