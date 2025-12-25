
import type { RuntimeEnv } from '../config/env.js';
import type { Logger } from '../utils/logger.util.js';
import type { TradeSignal, ActivePosition } from '../domain/trade.types.js';
import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';

export type TradeExecutorDeps = {
  adapter: IExchangeAdapter;
  env: RuntimeEnv;
  logger: Logger;
  proxyWallet: string; // Funder address
};

interface Position {
  conditionId: string;
  initialValue: number;
  currentValue: number;
}

export interface ExecutionResult {
    status: 'FILLED' | 'FAILED' | 'SKIPPED';
    txHash?: string;
    executedAmount: number; // USD Value
    executedShares: number; // Share Count
    priceFilled: number;    
    reason?: string;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; 
  
  private pendingSpend = 0;
  private lastBalanceFetch = 0;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Execute Exit: Uses an ultra-low floor (0.001) to sweep all available liquidity descending.
   * This handles illiquid books by hitting multiple bid levels instantly.
   */
  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      const { logger, adapter } = this.deps;
      let remainingShares = position.shares;
      
      try {
          logger.info(`📉 Executing Market Exit: Offloading ${remainingShares} shares of ${position.tokenId}...`);
          
          // PRODUCTION STRATEGY: Sweeping the book.
          // By setting the floor to 0.001 and using FAK, we fill as much as possible 
          // across all existing bid levels instantly.
          const result = await adapter.createOrder({
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome,
              side: 'SELL',
              sizeUsd: 0, 
              sizeShares: remainingShares,
              priceLimit: 0.001 // Sweep the book floor
          });
          
          if (result.success) {
              const filled = result.sharesFilled || 0;
              const diff = position.shares - filled;
              
              if (diff > 0.01) {
                  // Partial fill detected. This happens if the book runs out of bids above $0.001.
                  logger.warn(`⚠️ Partial Fill: Only liquidated ${filled}/${position.shares} shares. ${diff.toFixed(2)} shares remain stuck due to book depth.`);
                  if (diff < 5) {
                      logger.error(`🚨 Residual Dust: Remaining ${diff.toFixed(2)} shares are below exchange minimum (5). These cannot be sold until you buy more.`);
                  }
              }
              
              logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
              return true;
          } else {
              const errorStr = result.error || "Unknown Exchange Error";
              logger.error(`Exit attempt failed: ${errorStr}`);
              return false;
          }
          
      } catch (e: any) {
          logger.error(`Failed to execute manual exit: ${e.message}`, e as Error);
          return false;
      }
  }

  async copyTrade(signal: TradeSignal): Promise<ExecutionResult> {
    const { logger, env, adapter, proxyWallet } = this.deps;
    
    const failResult = (reason: string): ExecutionResult => ({
        status: 'SKIPPED',
        executedAmount: 0,
        executedShares: 0,
        priceFilled: 0,
        reason
    });

    try {
      let usableBalanceForTrade = 0;

      if (signal.side === 'BUY') {
          let chainBalance = 0;
          chainBalance = await adapter.fetchBalance(proxyWallet);
          usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
      } else {
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
      } catch (e) {
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
          if (usableBalanceForTrade < 1.00) return failResult("skipped_insufficient_balance_min_1");
          return failResult(sizing.reason || "skipped_size_too_small");
      }

      let priceLimit: number | undefined = undefined;
      const SLIPPAGE_PCT = 0.05; 

      if (signal.side === 'BUY') {
          priceLimit = signal.price * (1 + SLIPPAGE_PCT);
          if (priceLimit > 0.99) priceLimit = 0.99;
      } else {
          // AUTOMATED SELL SWEEP: Allow 10% slippage on follow-trades to prevent getting stuck
          priceLimit = signal.price * (1 - 0.10); 
          if (priceLimit < 0.001) priceLimit = 0.001;
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

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to copy trade: ${errorMessage}`, err as Error);
      return {
            status: 'FAILED',
            executedAmount: 0,
            executedShares: 0,
            priceFilled: 0,
            reason: errorMessage
      };
    }
  }

  private async getTraderBalance(trader: string): Promise<number> {
    const cached = this.balanceCache.get(trader);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
        return cached.value;
    }

    try {
      const positions: Position[] = await httpGet<Position[]>(
        `https://data-api.polymarket.com/positions?user=${trader}`,
      );
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
      const val = Math.max(1000, totalValue);
      
      this.balanceCache.set(trader, { value: val, timestamp: Date.now() });
      return val;
    } catch {
      return 10000; 
    }
  }
}