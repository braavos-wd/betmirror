
import { 
    IExchangeAdapter, 
    OrderParams
} from '../interfaces.js';
import { OrderBook } from '../../domain/market.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, MaxUint256 } from 'ethers';
import { ZeroDevService } from '../../services/zerodev.service.js';
import { ProxyWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getUsdBalanceApprox } from '../../utils/get-balance.util.js';
import { Logger } from '../../utils/logger.util.js';

// --- CONSTANTS ---
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

// --- ADAPTER: Ethers V6 Wallet -> V5 Compatibility ---
class EthersV6Adapter extends Wallet {
    async _signTypedData(domain: any, types: any, value: any): Promise<string> {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;
        if (domain.chainId) domain.chainId = Number(domain.chainId);
        return this.signTypedData(domain, cleanTypes, value);
    }
}

enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2
}

export class PolymarketAdapter implements IExchangeAdapter {
    readonly exchangeName = 'Polymarket';
    
    private client?: ClobClient;
    private signerImpl?: any;
    private funderAddress?: string | undefined; 
    private zdService?: ZeroDevService;
    private usdcContract?: Contract;
    
    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: ProxyWalletConfig;
            userId: string;
            l2ApiCredentials?: any;
            zeroDevRpc?: string;
            zeroDevPaymasterRpc?: string;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
        },
        private logger: Logger
    ) {}

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
        
        const provider = new JsonRpcProvider(this.config.rpcUrl);
        
        // 1. Setup Signer (Type 0 EOA)
        if (this.config.walletConfig.type === 'SMART_ACCOUNT') {
             if (!this.config.zeroDevRpc) throw new Error("Missing ZeroDev RPC");
             
             // AA Service for On-Chain Ops
             this.zdService = new ZeroDevService(
                 this.config.zeroDevRpc, 
                 this.config.zeroDevPaymasterRpc
             );

             this.funderAddress = this.config.walletConfig.address;
             
             if (!this.config.walletConfig.sessionPrivateKey) {
                 throw new Error("Missing Session Private Key for Auth");
             }
             
             // Use Adapter for V5 compatibility
             this.signerImpl = new EthersV6Adapter(this.config.walletConfig.sessionPrivateKey, provider);
             
        } else {
             // Legacy EOA support
             throw new Error("Only Smart Accounts supported in this adapter version.");
        }

        // 2. Setup USDC Contract for Allowance Checks
        this.usdcContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, this.signerImpl);
    }

    async validatePermissions(): Promise<boolean> {
        // Ensure On-Chain Deployment via ZeroDev
        if (this.zdService && this.funderAddress) {
            try {
                this.logger.info('🔄 Verifying Smart Account Deployment...');
                // Idempotent "Approve 0" tx to force deployment if needed
                await this.zdService.sendTransaction(
                    this.config.walletConfig.serializedSessionKey,
                    USDC_BRIDGED_POLYGON,
                    USDC_ABI,
                    'approve',
                    [this.funderAddress, 0]
                );
                return true;
            } catch (e: any) {
                this.logger.warn(`Deployment check note: ${e.message}`);
            }
        }
        return true;
    }

    async authenticate(): Promise<void> {
        // L2 Handshake Logic
        let apiCreds = this.config.l2ApiCredentials;

        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Performing L2 Handshake...');
            
            const tempClient = new ClobClient(
                'https://clob.polymarket.com',
                Chain.POLYGON,
                this.signerImpl,
                undefined,
                SignatureType.EOA, // Type 0
                this.funderAddress
            );

            try {
                const rawCreds = await tempClient.createOrDeriveApiKey();
                if (!rawCreds || !rawCreds.key) {
                    throw new Error("Handshake returned empty keys");
                }

                apiCreds = {
                    key: rawCreds.key,
                    secret: rawCreds.secret,
                    passphrase: rawCreds.passphrase
                };

                // Persist
                await User.findOneAndUpdate(
                    { address: this.config.userId },
                    { "proxyWallet.l2ApiCredentials": apiCreds }
                );
                this.logger.success('✅ Authenticated & Keys Saved.');
                
            } catch (e: any) {
                this.logger.error(`Auth Failed: ${e.message}`);
                throw e;
            }
        } else {
             this.logger.info('🔑 Using cached credentials.');
        }

        // Initialize Real Client
        let builderConfig: BuilderConfig | undefined;
        if (this.config.builderApiKey) {
            builderConfig = new BuilderConfig({ 
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret!,
                    passphrase: this.config.builderApiPassphrase!
                }
            });
        }

        this.client = new ClobClient(
            'https://clob.polymarket.com',
            Chain.POLYGON,
            this.signerImpl,
            apiCreds,
            SignatureType.EOA,
            this.funderAddress,
            undefined,
            undefined,
            builderConfig
        );
        
        // Ensure Allowance
        await this.ensureAllowance();
    }

    private async ensureAllowance() {
        if(!this.usdcContract || !this.funderAddress) return;
        try {
            const allowance = await this.usdcContract.allowance(this.funderAddress, POLYMARKET_EXCHANGE);
            if (allowance < BigInt(1000000 * 1000)) {
                this.logger.info('🔓 Approving USDC for Trading...');
                const tx = await this.usdcContract.approve(POLYMARKET_EXCHANGE, MaxUint256);
                await tx.wait();
                this.logger.success('✅ Approved.');
            }
        } catch(e) { 
            this.logger.warn("Allowance check skipped (AA delegation or RPC error)"); 
        }
    }

    async fetchBalance(address: string): Promise<number> {
        return await getUsdBalanceApprox(this.signerImpl, USDC_BRIDGED_POLYGON);
    }

    async getMarketPrice(marketId: string, tokenId: string): Promise<number> {
        if (!this.client) return 0;
        try {
            // Using midpoint as a proxy for price
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        } catch (e) {
            return 0;
        }
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Client not authenticated");
        const book = await this.client.getOrderBook(tokenId);
        // Map Polymarket Book to Generic Interface
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        };
    }

    async createOrder(params: OrderParams): Promise<string> {
        if (!this.client) throw new Error("Client not authenticated");
        
        const isBuy = params.side === 'BUY';
        const orderSide = isBuy ? Side.BUY : Side.SELL;

        // --- MARKET ORDER EXECUTION LOGIC ---
        // Loops to fill size, handling liquidity and FOK requirements
        let remaining = params.sizeUsd;
        let retryCount = 0;
        const maxRetries = 3;
        let lastTx = "";

        while (remaining > 0.50 && retryCount < maxRetries) { // Min order ~0.50
            const currentOrderBook = await this.client.getOrderBook(params.tokenId);
            const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;

            if (!currentLevels || currentLevels.length === 0) {
                 if (retryCount === 0) throw new Error("No liquidity in orderbook");
                 break; 
            }

            const level = currentLevels[0];
            const levelPrice = parseFloat(level.price);
            const levelSize = parseFloat(level.size);

            // Price Protection
            if (isBuy && params.priceLimit && levelPrice > params.priceLimit) break;
            if (!isBuy && params.priceLimit && levelPrice < params.priceLimit) break;

            let orderSize: number;
            let orderValue: number;

            if (isBuy) {
                const levelValue = levelSize * levelPrice;
                orderValue = Math.min(remaining, levelValue);
                orderSize = orderValue / levelPrice;
            } else {
                // For Sell, sizeUsd is essentially the value we want to exit
                const levelValue = levelSize * levelPrice;
                orderValue = Math.min(remaining, levelValue);
                orderSize = orderValue / levelPrice;
            }

            // Polymarket API precision handling
            orderSize = Math.floor(orderSize * 100) / 100;

            if (orderSize <= 0) break;

            const orderArgs = {
                side: orderSide,
                tokenID: params.tokenId,
                amount: orderSize,
                price: levelPrice,
            };

            try {
                const signedOrder = await this.client.createMarketOrder(orderArgs);
                const response = await this.client.postOrder(signedOrder, OrderType.FOK);

                if (response.success) {
                    remaining -= orderValue;
                    retryCount = 0;
                    lastTx = response.orderID || "filled";
                } else {
                    this.logger.warn(`FOK Failed. Retrying...`);
                    retryCount++;
                }
            } catch (error: any) {
                this.logger.error(`Order attempt failed: ${error.message}`);
                retryCount++;
            }
            
            // Brief pause between fills
            await new Promise(r => setTimeout(r, 200));
        }
        
        return lastTx || "failed";
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) {
            return false;
        }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        // This should delegate to FundManagerService logic ideally, 
        // but can be implemented here if we want the Adapter to handle withdrawals too.
        // For now, return empty as FundManager handles this via ZeroDevService directly.
        return "";
    }
    
    // Legacy Accessors
    public getRawClient() { return this.client; }
    public getSigner() { return this.signerImpl; }
    public getFunderAddress() { return this.funderAddress; }
}
