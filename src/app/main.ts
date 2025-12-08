
import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { createPolymarketClient } from '../infrastructure/clob-client.factory.js';
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { FundManagerService, FundManagerConfig } from '../services/fund-manager.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ConsoleLogger } from '../utils/logger.util.js';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util.js';
import { AlphaRegistryService } from '../services/alpha-registry.service.js';
import { IExchangeAdapter, OrderParams } from '../adapters/interfaces.js';
import { OrderBook } from '../domain/market.types.js';
import { Side, OrderType } from '@polymarket/clob-client';
import axios from 'axios';
import { TradeSignal } from '../domain/trade.types.js';

interface PolyActivityResponse {
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  size: number;
  usdcSize: number;
  price: number;
  side: string;
  outcomeIndex: number;
  transactionHash: string;
}

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const env = loadEnv();

  console.log(`
  ==============================================
   BET MIRROR | HEADLESS BOT MODE (CLI)
  ==============================================
  ℹ️  This process runs the bot logic on THIS machine/server.
  ℹ️  It reads keys from the local .env file.
  ℹ️  It does NOT provide a UI.
  ==============================================
  `);

  if (!env.privateKey) {
    logger.error('❌ STARTUP FAILED: No PRIVATE_KEY found in .env');
    logger.warn('To run the Headless Bot, you must configure a local .env file.');
    logger.warn('To run the Web Platform, use: npm run build && npm start');
    process.exit(1);
  }

  const client = await createPolymarketClient({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    apiKey: env.polymarketApiKey,
    apiSecret: env.polymarketApiSecret,
    apiPassphrase: env.polymarketApiPassphrase,
  });

  // Adapter wrapper for Headless Mode (EOA)
  const adapter: IExchangeAdapter = {
      exchangeName: 'PolymarketHeadless',
      initialize: async () => {},
      validatePermissions: async () => true,
      authenticate: async () => {}, 
      fetchBalance: async (address: string) => {
          if (address.toLowerCase() === client.wallet.address.toLowerCase()) {
              return getUsdBalanceApprox(client.wallet, env.usdcContractAddress);
          }
          return 0; 
      },
      getMarketPrice: async () => 0, 
      getOrderBook: async (tokenId: string): Promise<OrderBook> => {
          const book = await client.getOrderBook(tokenId);
          return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
          };
      },
      fetchPublicTrades: async (address: string, limit: number = 20): Promise<TradeSignal[]> => {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            const res = await axios.get<PolyActivityResponse[]>(url);
            
            if (!res.data || !Array.isArray(res.data)) return [];

            const trades: TradeSignal[] = [];
            for (const act of res.data) {
                if (act.type === 'TRADE' || act.type === 'ORDER_FILLED') {
                     const activityTime = typeof act.timestamp === 'number' ? act.timestamp : Math.floor(new Date(act.timestamp).getTime() / 1000);
                     
                     trades.push({
                         trader: address,
                         marketId: act.conditionId,
                         tokenId: act.asset,
                         outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                         side: act.side.toUpperCase() as 'BUY' | 'SELL',
                         sizeUsd: act.usdcSize || (act.size * act.price),
                         price: act.price,
                         timestamp: activityTime * 1000,
                     });
                }
            }
            return trades;
        } catch (e) {
            return [];
        }
      },
      createOrder: async (params: OrderParams): Promise<string> => {
          const isBuy = params.side === 'BUY';
          const orderSide = isBuy ? Side.BUY : Side.SELL;
          
          try {
             const currentOrderBook = await client.getOrderBook(params.tokenId);
             const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;
             if (!currentLevels || currentLevels.length === 0) throw new Error("No liquidity");
             
             const level = currentLevels[0];
             const price = parseFloat(level.price);
             if (params.priceLimit) {
                 if (isBuy && price > params.priceLimit) throw new Error("Price too high");
                 if (!isBuy && price < params.priceLimit) throw new Error("Price too low");
             }

             const size = params.sizeUsd / price;
             const safeSize = Math.floor(size * 100) / 100;
             if (safeSize <= 0) return "skipped_small_size";

             const orderArgs = {
                side: orderSide,
                tokenID: params.tokenId,
                amount: safeSize,
                price: price,
             };
             
             const signedOrder = await client.createMarketOrder(orderArgs);
             const response = await client.postOrder(signedOrder, OrderType.FOK);
             
             if(response.success) return response.orderID || "filled";
             throw new Error(response.errorMsg || "Order failed");
        } catch(e: any) {
            logger.error("Headless Order Failed", e);
            throw e;
        }
      },
      cancelOrder: async () => true,
      cashout: async () => "",
  };

  const notifier = new NotificationService(env, logger);
  
  const fundManagerConfig: FundManagerConfig = {
      enabled: env.enableAutoCashout,
      maxRetentionAmount: env.maxRetentionAmount,
      destinationAddress: env.mainWalletAddress
  };

  const registryService = new AlphaRegistryService(env.registryApiUrl);

  const fundManager = new FundManagerService(adapter, client.wallet.address, fundManagerConfig, logger, notifier);
  const feeDistributor = new FeeDistributorService(client.wallet, env, logger, registryService);

  try {
    const polBalance = await getPolBalance(client.wallet);
    const usdcBalance = await getUsdBalanceApprox(client.wallet, env.usdcContractAddress);
    logger.info(`🔐 Headless Wallet: ${client.wallet.address}`);
    logger.info(`💰 Balance: ${usdcBalance.toFixed(2)} USDC | ${polBalance.toFixed(4)} POL`);
    
    await fundManager.checkAndSweepProfits();
  } catch (err) {
    logger.error('Failed to fetch balances', err as Error);
  }

  const executor = new TradeExecutorService({ 
    adapter, 
    proxyWallet: env.proxyWallet, 
    logger, 
    env 
  });

  const monitor = new TradeMonitorService({
    adapter,
    logger,
    env,
    userAddresses: env.userAddresses,
    onDetectedTrade: async (signal) => {
      await executor.copyTrade(signal);
      
      if (signal.side === 'SELL') {
          const estimatedProfit = signal.sizeUsd * 0.1; 
          if (estimatedProfit > 0) {
              await feeDistributor.distributeFeesOnProfit(
                  signal.marketId, 
                  estimatedProfit, 
                  signal.trader
              );
          }
      }

      await notifier.sendTradeAlert(signal);
      
      setTimeout(async () => {
        await fundManager.checkAndSweepProfits();
      }, 15000);
    },
  });

  await monitor.start(Math.floor(Date.now() / 1000));
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
