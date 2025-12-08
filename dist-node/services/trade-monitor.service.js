import { httpGet } from '../utils/http.js';
import axios from 'axios';
export class TradeMonitorService {
    constructor(deps) {
        // UPGRADE: Use Map<Hash, Timestamp> for LRU pruning instead of infinite Set
        // This ensures the bot doesn't crash from OOM after running for weeks.
        this.processedHashes = new Map();
        this.lastFetchTime = new Map();
        this.isPolling = false;
        this.deps = deps;
    }
    async start(startCursor) {
        const { logger, env } = this.deps;
        logger.info(`Initializing Monitor for ${this.deps.userAddresses.length} target wallets...`);
        // If a startCursor is provided, initialize lastFetchTime for all traders
        if (startCursor) {
            this.deps.userAddresses.forEach(trader => {
                this.lastFetchTime.set(trader, startCursor);
            });
        }
        // Initial sync
        await this.tick();
        // Setup robust polling
        this.timer = setInterval(async () => {
            if (this.isPolling)
                return; // Prevent overlap
            this.isPolling = true;
            try {
                await this.tick();
            }
            catch (e) {
                // Critical: Catch socket hang ups here so the interval doesn't die
                if (e.code === 'ECONNRESET' || e.message?.includes('socket hang up')) {
                    // Silent retry
                }
                else {
                    console.error("[Monitor] Tick Error:", e.message);
                }
            }
            finally {
                this.isPolling = false;
            }
        }, env.fetchIntervalSeconds * 1000);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.isPolling = false;
    }
    async tick() {
        const { env } = this.deps;
        const now = Math.floor(Date.now() / 1000);
        const cutoffTime = now - Math.max(env.aggregationWindowSeconds, 600);
        // MEMORY OPTIMIZATION: Prune old hashes (LRU-like)
        // If cache gets too big, remove entries older than the window
        if (this.processedHashes.size > 2000) {
            for (const [hash, ts] of this.processedHashes.entries()) {
                if (ts < cutoffTime) {
                    this.processedHashes.delete(hash);
                }
            }
        }
        // Process wallets in parallel chunks to avoid blocking
        const chunkSize = 5;
        for (let i = 0; i < this.deps.userAddresses.length; i += chunkSize) {
            const chunk = this.deps.userAddresses.slice(i, i + chunkSize);
            await Promise.all(chunk.map(trader => {
                if (!trader || trader.length < 10)
                    return Promise.resolve();
                return this.fetchTraderActivities(trader, env, now, cutoffTime);
            }));
        }
    }
    async fetchTraderActivities(trader, env, now, cutoffTime) {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${trader}&limit=20`;
            // Use robust httpGet which handles retries internally
            const activities = await httpGet(url);
            if (!activities || !Array.isArray(activities))
                return;
            for (const activity of activities) {
                if (activity.type !== 'TRADE' && activity.type !== 'ORDER_FILLED')
                    continue;
                const activityTime = typeof activity.timestamp === 'number' ? activity.timestamp : Math.floor(new Date(activity.timestamp).getTime() / 1000);
                // Skip old trades
                if (activityTime < cutoffTime)
                    continue;
                // Skip already processed
                if (this.processedHashes.has(activity.transactionHash))
                    continue;
                // Skip trades before start cursor
                const lastTime = this.lastFetchTime.get(trader) || 0;
                if (activityTime <= lastTime)
                    continue;
                const signal = {
                    trader,
                    marketId: activity.conditionId,
                    tokenId: activity.asset,
                    outcome: activity.outcomeIndex === 0 ? 'YES' : 'NO',
                    side: activity.side.toUpperCase(),
                    sizeUsd: activity.usdcSize || (activity.size * activity.price),
                    price: activity.price,
                    timestamp: activityTime * 1000,
                };
                this.deps.logger.info(`[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price} ($${signal.sizeUsd.toFixed(0)}) from ${trader.slice(0, 6)}`);
                // Mark as processed
                this.processedHashes.set(activity.transactionHash, activityTime);
                // Update high-water mark
                this.lastFetchTime.set(trader, Math.max(this.lastFetchTime.get(trader) || 0, activityTime));
                await this.deps.onDetectedTrade(signal);
            }
        }
        catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 404) {
                return;
            }
        }
    }
}
