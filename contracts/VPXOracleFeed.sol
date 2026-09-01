// SPDX-License-Identifier: BSL-1.1
// AXIOLEDGER — VALIPRECISION ($VPX)
// VPXOracleFeed.sol — On-Chain Price Oracle
//
// Ref: Whitepaper §11.12 · oracle-nodes price pusher
//
// Architecture:
//   Off-chain node (price-feed.js) → median aggregation
//   → on-chain-pusher.js (ethers.js v6)
//   → VPXOracleFeed.updatePrice()
//   → kinetoprotocol/KPXRouterGateway calls getLatestPrice()

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title  VPXOracleFeed
 * @author AXIOLEDGER Core Team
 * @notice Price oracle for AXIOLEDGER ecosystem.
 *         Prices are pushed by authorized off-chain oracle nodes.
 *
 * @dev Price precision: 18 decimals (1e18 = $1.00)
 *      Staleness check: getLatestPrice reverts if data older than STALE_THRESHOLD
 *      TWAP: getTWAP returns median over last N rounds (manipulation-resistant)
 */
contract VPXOracleFeed is AccessControl, Pausable {

    // ── Roles ──────────────────────────────────────────────────────────────────
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────────
    uint256 public constant STALE_THRESHOLD  = 10 minutes;
    uint256 public constant MAX_TWAP_PERIODS = 100;
    uint256 public constant PRICE_DECIMALS   = 18;

    // ── Data structures ────────────────────────────────────────────────────────

    struct OracleData {
        uint256 price;      // USD price × 10^18
        uint256 timestamp;  // Unix seconds of last update
        uint256 roundId;    // Monotonically increasing per asset
    }

    struct RoundData {
        uint256 price;
        uint256 timestamp;
    }

    // ── State ──────────────────────────────────────────────────────────────────

    /// @notice Latest price data per asset (bytes32 asset key)
    mapping(bytes32 => OracleData) public latestData;

    /// @notice Historical rounds per asset (roundId → RoundData)
    mapping(bytes32 => mapping(uint256 => RoundData)) public rounds;

    // ── Events ─────────────────────────────────────────────────────────────────

    event PriceUpdated(
        bytes32 indexed asset,
        uint256 price,
        uint256 timestamp,
        uint256 roundId,
        address indexed pusher
    );

    event OracleNodeAdded(address indexed node);
    event OracleNodeRemoved(address indexed node);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error StalePrice(bytes32 asset, uint256 lastUpdate, uint256 currentTime);
    error NoDataForAsset(bytes32 asset);
    error InvalidPrice();
    error InvalidTimestamp();

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address admin) {
        require(admin != address(0), "VPX: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ── Oracle node management ─────────────────────────────────────────────────

    function addOracleNode(address node) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(ORACLE_ROLE, node);
        emit OracleNodeAdded(node);
    }

    function removeOracleNode(address node) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ORACLE_ROLE, node);
        emit OracleNodeRemoved(node);
    }

    // ── Price update ───────────────────────────────────────────────────────────

    /**
     * @notice Push new price for an asset. Only callable by ORACLE_ROLE.
     * @param asset     bytes32 asset key (e.g. encodeBytes32String("ETH"))
     * @param price     USD price × 10^18
     * @param timestamp Unix seconds of the price observation
     */
    function updatePrice(
        bytes32 asset,
        uint256 price,
        uint256 timestamp
    ) external whenNotPaused onlyRole(ORACLE_ROLE) {
        if (price == 0) revert InvalidPrice();
        if (timestamp == 0 || timestamp > block.timestamp + 60) revert InvalidTimestamp();

        // Reject stale pushes (older than last update)
        OracleData storage current = latestData[asset];
        if (timestamp < current.timestamp) revert InvalidTimestamp();

        uint256 newRoundId = current.roundId + 1;

        // Update latest
        latestData[asset] = OracleData({
            price:     price,
            timestamp: timestamp,
            roundId:   newRoundId
        });

        // Store round history (capped implicitly by gas — caller's concern)
        rounds[asset][newRoundId] = RoundData({ price: price, timestamp: timestamp });

        emit PriceUpdated(asset, price, timestamp, newRoundId, msg.sender);
    }

    // ── Price queries ──────────────────────────────────────────────────────────

    /**
     * @notice Get latest price. Reverts if data is stale (>10 min).
     * @param asset bytes32 asset key
     * @return price     USD price × 10^18
     * @return timestamp Unix seconds of last update
     * @return roundId   Current round number
     */
    function getLatestPrice(bytes32 asset)
        external view
        returns (uint256 price, uint256 timestamp, uint256 roundId)
    {
        OracleData memory data = latestData[asset];
        if (data.roundId == 0) revert NoDataForAsset(asset);
        if (block.timestamp - data.timestamp > STALE_THRESHOLD) {
            revert StalePrice(asset, data.timestamp, block.timestamp);
        }
        return (data.price, data.timestamp, data.roundId);
    }

    /**
     * @notice Get Time-Weighted Average Price over last `periods` rounds.
     *         Uses median across rounds for manipulation resistance.
     * @param asset   bytes32 asset key
     * @param periods Number of recent rounds (max MAX_TWAP_PERIODS)
     * @return twap   Median price × 10^18
     */
    function getTWAP(bytes32 asset, uint256 periods)
        external view
        returns (uint256 twap)
    {
        require(periods > 0 && periods <= MAX_TWAP_PERIODS, "VPX: invalid periods");

        OracleData memory latest = latestData[asset];
        if (latest.roundId == 0) revert NoDataForAsset(asset);

        uint256 count = periods < latest.roundId ? periods : latest.roundId;
        uint256[] memory prices = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            uint256 rid = latest.roundId - i;
            prices[i] = rounds[asset][rid].price;
        }

        // Sort and return median (bubble sort — acceptable for count ≤ 100)
        for (uint256 i = 0; i < count - 1; i++) {
            for (uint256 j = 0; j < count - i - 1; j++) {
                if (prices[j] > prices[j + 1]) {
                    (prices[j], prices[j + 1]) = (prices[j + 1], prices[j]);
                }
            }
        }

        uint256 mid = count / 2;
        twap = count % 2 != 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    }

    // ── Emergency controls ─────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }
}
