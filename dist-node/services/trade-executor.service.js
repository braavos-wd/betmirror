import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { LiquidityHealth } from '../adapters/interfaces.js';
export class TradeExecutorService {
    deps;
    balanceCache = new Map();
    CACHE_TTL = 5 * 60 * 1000;
    pendingSpend = 0;
    lastBalanceFetch = 0;
    constructor(deps) {
        this.deps = deps;
    }
    async executeManualExit(position, currentPrice) {
        const { logger, adapter } = this.deps;
        let remainingShares = position.shares;
        try {
            logger.info(`📉 Executing Market Exit: Offloading ${remainingShares} shares of ${position.tokenId}...`);
            const result = await adapter.createOrder({
                marketId: position.marketId,
                tokenId: position.tokenId,
                outcome: position.outcome,
                side: 'SELL',
                sizeUsd: 0,
                sizeShares: remainingShares,
                priceLimit: 0.001
            });
            if (result.success) {
                const filled = result.sharesFilled || 0;
                const diff = position.shares - filled;
                if (diff > 0.01) {
                    logger.warn(`⚠️ Partial Fill: Only liquidated ${filled}/${position.shares} shares. ${diff.toFixed(2)} shares remain stuck due to book depth.`);
                    if (diff < 5) {
                        logger.error(`🚨 Residual Dust: Remaining ${diff.toFixed(2)} shares are below exchange minimum (5). These cannot be sold until you buy more.`);
                    }
                }
                logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
                return true;
            }
            else {
                const errorStr = result.error || "Unknown Exchange Error";
                logger.error(`Exit attempt failed: ${errorStr}`);
                return false;
            }
        }
        catch (e) {
            logger.error(`Failed to execute manual exit: ${e.message}`, e);
            return false;
        }
    }
    async copyTrade(signal) {
        const { logger, env, adapter, proxyWallet } = this.deps;
        const failResult = (reason, status = 'SKIPPED') => ({
            status,
            executedAmount: 0,
            executedShares: 0,
            priceFilled: 0,
            reason
        });
        try {
            // PRE-FLIGHT LIQUIDITY GUARD
            if (this.deps.adapter.getLiquidityMetrics) {
                const metrics = await this.deps.adapter.getLiquidityMetrics(signal.tokenId, signal.side);
                const minRequired = this.deps.env.minLiquidityFilter || 'LOW';
                const ranks = {
                    [LiquidityHealth.HIGH]: 3,
                    [LiquidityHealth.MEDIUM]: 2,
                    [LiquidityHealth.LOW]: 1,
                    [LiquidityHealth.CRITICAL]: 0
                };
                if (ranks[metrics.health] < ranks[minRequired]) {
                    const msg = `[Liquidity Filter] Market health ${metrics.health} is below your required ${minRequired} threshold. (Spread: ${metrics.spreadPercent.toFixed(1)}%, Depth: $${metrics.availableDepthUsd.toFixed(0)}) -> SKIPPING`;
                    logger.warn(msg);
                    return failResult("insufficient_liquidity", "ILLIQUID");
                }
            }
            let usableBalanceForTrade = 0;
            if (signal.side === 'BUY') {
                let chainBalance = 0;
                chainBalance = await adapter.fetchBalance(proxyWallet);
                usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
            }
            else {
                const positions = await adapter.getPositions(proxyWallet);
                const myPosition = positions.find(p => p.tokenId === signal.tokenId);
                if (!myPosition || myPosition.balance <= 0) {
                    return failResult("no_position_to_sell");
                }
                usableBalanceForTrade = myPosition.valueUsd;
            }
            const traderBalance = await this.getTraderBalance(signal.trader);
            let minOrderSize = 5;
            try {
                const book = await adapter.getOrderBook(signal.tokenId);
                if (book.min_order_size) {
                    minOrderSize = Number(book.min_order_size);
                }
            }
            catch (e) {
                logger.debug(`Using default minOrderSize: ${minOrderSize}`);
            }
            const sizing = computeProportionalSizing({
                yourUsdBalance: usableBalanceForTrade,
                traderUsdBalance: traderBalance,
                traderTradeUsd: signal.sizeUsd,
                multiplier: env.tradeMultiplier,
                currentPrice: signal.price,
                maxTradeAmount: env.maxTradeAmount,
                minOrderSize: minOrderSize
            });
            if (sizing.targetUsdSize < 1.00 || sizing.targetShares < minOrderSize) {
                if (usableBalanceForTrade < 1.00)
                    return failResult("skipped_insufficient_balance_min_1");
                return failResult(sizing.reason || "skipped_size_too_small");
            }
            let priceLimit = undefined;
            const SLIPPAGE_PCT = 0.05;
            if (signal.side === 'BUY') {
                priceLimit = signal.price * (1 + SLIPPAGE_PCT);
                if (priceLimit > 0.99)
                    priceLimit = 0.99;
            }
            else {
                priceLimit = signal.price * (1 - 0.10);
                if (priceLimit < 0.001)
                    priceLimit = 0.001;
            }
            logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares)`);
            const result = await adapter.createOrder({
                marketId: signal.marketId,
                tokenId: signal.tokenId,
                outcome: signal.outcome,
                side: signal.side,
                sizeUsd: sizing.targetUsdSize,
                priceLimit: priceLimit
            });
            if (!result.success) {
                return {
                    status: 'FAILED',
                    executedAmount: 0,
                    executedShares: 0,
                    priceFilled: 0,
                    reason: result.error || 'Unknown error'
                };
            }
            if (signal.side === 'BUY') {
                this.pendingSpend += sizing.targetUsdSize;
            }
            return {
                status: 'FILLED',
                txHash: result.orderId || result.txHash,
                executedAmount: result.sharesFilled * result.priceFilled,
                executedShares: result.sharesFilled,
                priceFilled: result.priceFilled,
                reason: 'executed'
            };
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to copy trade: ${errorMessage}`, err);
            return {
                status: 'FAILED',
                executedAmount: 0,
                executedShares: 0,
                priceFilled: 0,
                reason: errorMessage
            };
        }
    }
    async getTraderBalance(trader) {
        const cached = this.balanceCache.get(trader);
        if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
            return cached.value;
        }
        try {
            const positions = await httpGet(`https://data-api.polymarket.com/positions?user=${trader}`);
            const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
            const val = Math.max(1000, totalValue);
            this.balanceCache.set(trader, { value: val, timestamp: Date.now() });
            return val;
        }
        catch {
            return 10000;
        }
    }
}
