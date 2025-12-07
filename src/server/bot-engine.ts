import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService, FundManagerConfig } from '../services/fund-manager.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ZeroDevService } from '../services/zerodev.service.js';
import { TradeHistoryEntry, ActivePosition } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { ProxyWalletConfig, L2ApiCredentials } from '../domain/wallet.types.js'; 
import { ClobClient, Chain, ApiKeyCreds } from '@polymarket/clob-client';
import { Wallet, AbstractSigner, Provider, JsonRpcProvider, TransactionRequest, Contract, MaxUint256 } from 'ethers';
import { BotLog, User } from '../database/index.js';
import { BuilderConfig, BuilderApiKeyCreds } from '@polymarket/builder-signing-sdk';
import { getMarket } from '../utils/fetch-data.util.js';
import { getUsdBalanceApprox } from '../utils/get-balance.util.js';

// Define the correct USDC.e address on Polygon
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- SIGNATURE TYPES ---
enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2
}

// --- ADAPTER: Ethers V6 Wallet -> V5 Compatibility ---
// Polymarket SDK expects _signTypedData (v5), but Ethers v6 uses signTypedData.
class EthersV6Adapter extends Wallet {
    async _signTypedData(domain: any, types: any, value: any): Promise<string> {
        // Sanitize types: Remove EIP712Domain if present (v6 handles it automatically)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;
        
        // Ensure chainId is a number
        if (domain.chainId) domain.chainId = Number(domain.chainId);
        
        return this.signTypedData(domain, cleanTypes, value);
    }
}

// --- ADAPTER: ZeroDev (Viem) -> Ethers.js Signer ---
// Used ONLY for on-chain interactions (withdrawals), NOT for CLOB Auth
class KernelEthersSigner extends AbstractSigner {
    private kernelClient: any;
    private address: string;
    
    constructor(kernelClient: any, address: string, provider: Provider) {
        super(provider);
        this.kernelClient = kernelClient;
        this.address = address;
    }

    async getAddress(): Promise<string> {
        return this.address;
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
        return await this.kernelClient.signMessage({ 
            message: typeof message === 'string' ? message : { raw: message } 
        });
    }

    async signTypedData(domain: any, types: any, value: any): Promise<string> {
        const primaryType = Object.keys(types)[0];
        const sanitizedDomain = { ...domain };
        if (sanitizedDomain.chainId) sanitizedDomain.chainId = Number(sanitizedDomain.chainId);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;

        return await this.kernelClient.signTypedData({
            domain: sanitizedDomain,
            types: cleanTypes,
            primaryType, 
            message: value
        });
    }

    async _signTypedData(domain: any, types: any, value: any): Promise<string> {
        return this.signTypedData(domain, types, value);
    }

    async signTransaction(tx: TransactionRequest): Promise<string> {
        throw new Error("signTransaction not supported. Use sendTransaction.");
    }

    async sendTransaction(tx: TransactionRequest): Promise<any> {
        const hash = await this.kernelClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value.toString()) : BigInt(0)
        });
        return {
            hash,
            wait: async () => {
                if(this.provider) return await this.provider.waitForTransaction(hash);
                return { hash };
            }
        };
    }

    connect(provider: Provider | null): AbstractSigner {
        return new KernelEthersSigner(this.kernelClient, this.address, provider || this.provider!);
    }
}

export interface BotConfig {
    userId: string;
    privateKey?: string;
    walletConfig?: ProxyWalletConfig;
    userAddresses: string[];
    rpcUrl: string;
    geminiApiKey?: string;
    riskProfile: 'conservative' | 'balanced' | 'degen';
    multiplier: number;
    autoTp?: number;
    enableNotifications: boolean;
    userPhoneNumber?: string;
    autoCashout?: { enabled: boolean; maxAmount: number; destinationAddress: string; };
    activePositions?: ActivePosition[];
    stats?: UserStats;
    zeroDevRpc?: string;
    zeroDevPaymasterRpc?: string;
    l2ApiCredentials?: L2ApiCredentials;
    startCursor?: number;
}

export interface BotCallbacks {
    onCashout?: (record: CashoutRecord) => Promise<void>;
    onFeePaid?: (record: FeeDistributionEvent) => Promise<void>;
    onTradeComplete?: (trade: TradeHistoryEntry) => Promise<void>;
    onStatsUpdate?: (stats: UserStats) => Promise<void>;
    onPositionsUpdate?: (positions: ActivePosition[]) => Promise<void>;
}

const USDC_ABI_MINIMAL = [
    'function approve(address spender, uint256 amount) returns (bool)'
];

export class BotEngine {
    public isRunning = false;
    private monitor?: TradeMonitorService;
    private executor?: TradeExecutorService;
    private client?: ClobClient & { wallet: any };
    private fundWatcher?: NodeJS.Timeout;
    private watchdogTimer?: NodeJS.Timeout;
    private activePositions: ActivePosition[] = [];
    private stats: UserStats = {
        totalPnl: 0, totalVolume: 0, totalFeesPaid: 0, winRate: 0, tradesCount: 0, allowanceApproved: false
    };

    // Store these for the delayed startup
    private signerImpl: any;
    private funderAddress: string | undefined;
    private zdService?: ZeroDevService;

    constructor(
        private config: BotConfig,
        private registryService: IRegistryService,
        private callbacks?: BotCallbacks
    ) {
        if (config.activePositions) this.activePositions = config.activePositions;
        if (config.stats) this.stats = config.stats;
    }

    private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string) {
        try {
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() });
        } catch (e) { console.error("Log failed", e); }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            await this.addLog('info', '🚀 Starting Engine...');

            const provider = new JsonRpcProvider(this.config.rpcUrl);

            // --- STEP 1: INITIALIZE L1 SIGNER ---
            if (this.config.walletConfig?.type === 'SMART_ACCOUNT') {
                const rpc = this.config.zeroDevRpc;
                const paymaster = this.config.zeroDevPaymasterRpc;
                
                if (!rpc) throw new Error("Missing ZeroDev RPC");

                this.zdService = new ZeroDevService(rpc, paymaster);
                this.funderAddress = this.config.walletConfig.address;
                
                if (!this.config.walletConfig.sessionPrivateKey) {
                     throw new Error("Missing Session Private Key. Please click 'RESTORE SESSION' in the dashboard to fix.");
                }
                
                // USE ADAPTER: Wraps Ethers v6 Wallet to support v5 calls like _signTypedData
                this.signerImpl = new EthersV6Adapter(this.config.walletConfig.sessionPrivateKey, provider);
                
                console.log(`[L1 SETUP] EOA Signer (Adapter): ${this.signerImpl.address}`);
                console.log(`[L1 SETUP] Smart Funder: ${this.funderAddress}`);

            } else if (this.config.privateKey) {
                // Legacy EOA - Also use adapter for consistency
                this.signerImpl = new EthersV6Adapter(this.config.privateKey, provider);
                this.funderAddress = this.signerImpl.address;
                await this.addLog('info', `Using EOA: ${this.signerImpl.address.slice(0,6)}...`);
            }

            if (!this.signerImpl) throw new Error("Could not initialize signer");
            
            // --- STEP 2: CHECK FUNDING (Non-Blocking) ---
            const isFunded = await this.checkFunding();
            
            if (!isFunded) {
                await this.addLog('warn', '💰 Account Empty (Checking USDC.e). Engine standby. Waiting for deposit...');
                this.startFundWatcher();
                return; 
            }

            await this.proceedWithPostFundingSetup();

        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Startup Failed: ${e.message}`);
            this.isRunning = false;
        }
    }

    private async checkFunding(): Promise<boolean> {
        try {
            // Check Smart Account Balance (Funder) using EOA Provider to query chain
            const addressToCheck = this.funderAddress || await this.signerImpl.getAddress();
            const contract = new Contract(USDC_BRIDGED_POLYGON, ['function balanceOf(address) view returns (uint256)'], this.signerImpl);
            const balance = await contract.balanceOf(addressToCheck);
            // > 0.10 USDC to start
            return Number(balance) > 100000; 
        } catch (e) {
            return false;
        }
    }

    private startFundWatcher() {
        if (this.fundWatcher) clearInterval(this.fundWatcher);
        this.fundWatcher = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(this.fundWatcher);
                return;
            }
            const funded = await this.checkFunding();
            if (funded) {
                clearInterval(this.fundWatcher);
                this.fundWatcher = undefined;
                await this.addLog('success', '💰 Funds detected. Resuming startup...');
                await this.proceedWithPostFundingSetup();
            }
        }, 30000); 
    }

    // Force On-Chain Key Registration (Idempotent)
    private async activateOnChain() {
        try {
            if (this.config.walletConfig?.type !== 'SMART_ACCOUNT' || !this.zdService || !this.funderAddress) {
                return;
            }

            await this.addLog('info', '🔄 Syncing Session Key on-chain...');
            
            const txHash = await this.zdService.sendTransaction(
                this.config.walletConfig.serializedSessionKey,
                USDC_BRIDGED_POLYGON,
                USDC_ABI_MINIMAL,
                'approve',
                [this.funderAddress, 0]
            );

            console.log(`[ON-CHAIN] Activation Tx: ${txHash}`);
            await this.addLog('success', '✅ Smart Account Ready.');
            
            // Short wait
            await sleep(5000); 

        } catch (e: any) {
             console.log("[ON-CHAIN] Note:", e.message);
        }
    }

    private async proceedWithPostFundingSetup() {
        try {
            // 1. Ensure Deployed
            await this.activateOnChain();

            // 2. L2 Handshake
            let apiCreds: ApiKeyCreds | undefined;
            const dbCreds = this.config.l2ApiCredentials;

            if (dbCreds && dbCreds.key && dbCreds.secret) {
                console.log(`[L2 AUTH] Credentials found in DB.`);
                apiCreds = {
                    key: dbCreds.key,
                    secret: dbCreds.secret,
                    passphrase: dbCreds.passphrase
                };
            } else {
                await this.addLog('info', '🤝 L2 Keys missing. Initiating Handshake...');
                
                // TEMP CLIENT: Use EOA Adapter + Type 0 + Smart Funder
                const tempClient = new ClobClient(
                    'https://clob.polymarket.com',
                    Chain.POLYGON,
                    this.signerImpl, // EOA Adapter with _signTypedData shim
                    undefined, 
                    SignatureType.EOA, // 0 
                    this.funderAddress // Smart Account Address
                );

                try {
                    let rawCreds: any = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            console.log(`[L2 HANDSHAKE] Attempt ${attempt}...`);
                            rawCreds = await tempClient.createOrDeriveApiKey();
                            console.log(`[L2 HANDSHAKE] Success:`, rawCreds?.key ? 'YES' : 'NO'); 
                            if(rawCreds && (rawCreds.key || rawCreds.apiKey)) break;
                        } catch(e: any) {
                            console.warn(`[L2 HANDSHAKE] Attempt ${attempt} failed: ${e.message}`);
                            if (attempt === 3) throw e; 
                            await sleep(2000);
                        }
                    }

                    if (!rawCreds || (!rawCreds.key && !rawCreds.apiKey)) {
                        throw new Error("Handshake returned empty keys");
                    }

                    apiCreds = {
                        key: rawCreds.apiKey || rawCreds.key,
                        secret: rawCreds.secret || rawCreds.apiSecret,
                        passphrase: rawCreds.passphrase || rawCreds.apiPassphrase
                    };

                    // Persist to DB
                    await User.findOneAndUpdate(
                        { address: this.config.userId },
                        { "proxyWallet.l2ApiCredentials": apiCreds }
                    );
                    await this.addLog('success', '✅ L2 Handshake Complete.');

                } catch (e: any) {
                    if (e.message?.includes('401')) {
                        await this.addLog('error', '❌ L2 Auth Failed (401). Ensure your EOA is the authorized signer for this Smart Account.');
                    }
                    throw e;
                }
            }

            // 3. Initialize REAL Trading Client
            await this.addLog('info', '🔌 Connecting to CLOB...');
            
            let builderConfig: BuilderConfig | undefined;
            if (process.env.POLY_BUILDER_API_KEY) {
                builderConfig = new BuilderConfig({ 
                    localBuilderCreds: {
                        key: process.env.POLY_BUILDER_API_KEY!,
                        secret: process.env.POLY_BUILDER_SECRET!,
                        passphrase: process.env.POLY_BUILDER_PASSPHRASE!
                    }
                });
            }

            this.client = new ClobClient(
                'https://clob.polymarket.com',
                Chain.POLYGON,
                this.signerImpl, // EOA Adapter
                apiCreds,
                SignatureType.EOA, // 0
                this.funderAddress,
                undefined,
                undefined,
                builderConfig
            ) as any;
            
            if(!this.client!.wallet) (this.client as any).wallet = this.signerImpl;

            // 4. Start Services
            this.startServices();

        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Setup Failed: ${e.message}`);
            this.isRunning = false; 
        }
    }

    private async startServices() {
        const runtimeEnv: any = {
            tradeMultiplier: this.config.multiplier,
            usdcContractAddress: USDC_BRIDGED_POLYGON,
            adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET,
            enableNotifications: this.config.enableNotifications,
            userPhoneNumber: this.config.userPhoneNumber,
            twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
            twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
            twilioFromNumber: process.env.TWILIO_FROM_NUMBER
        };
        
        const dummyLogger = {
            info: (m: string) => console.log(m),
            warn: (m: string) => console.warn(m),
            error: (m: string, e?: any) => console.error(m, e),
            debug: () => {}
        };

        // Executor
        this.executor = new TradeExecutorService({
            client: this.client as any,
            proxyWallet: this.funderAddress!,
            env: runtimeEnv,
            logger: dummyLogger
        });

        // Allowance Check
        try {
            await this.executor.ensureAllowance();
        } catch (e) { console.warn("Allowance check skipped/failed (Non-critical for AA)"); }

        // Monitor
        this.monitor = new TradeMonitorService({
            client: this.client as any,
            env: { ...runtimeEnv, fetchIntervalSeconds: 2, aggregationWindowSeconds: 300 },
            logger: dummyLogger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal) => {
                if (!this.isRunning) return;
                
                const geminiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY;
                let shouldTrade = true;
                let reason = "AI Disabled";
                let score = 0;

                if (geminiKey) {
                    await this.addLog('info', `[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price}`);
                    const analysis = await aiAgent.analyzeTrade(
                        `Market: ${signal.marketId}`,
                        signal.side,
                        signal.outcome,
                        signal.sizeUsd,
                        signal.price,
                        this.config.riskProfile,
                        geminiKey
                    );
                    shouldTrade = analysis.shouldCopy;
                    reason = analysis.reasoning;
                    score = analysis.riskScore;
                }

                if (shouldTrade && this.executor) {
                    await this.addLog('info', `⚡ Executing ${signal.side}...`);
                    const size = await this.executor.copyTrade(signal);
                    if (size > 0) {
                        await this.addLog('success', `✅ Executed ${signal.marketId.slice(0,6)}...`);
                        
                        if (signal.side === 'BUY') {
                            this.activePositions.push({
                                marketId: signal.marketId,
                                tokenId: signal.tokenId,
                                outcome: signal.outcome,
                                entryPrice: signal.price,
                                sizeUsd: size,
                                timestamp: Date.now()
                            });
                        }
                        
                        this.stats.tradesCount = (this.stats.tradesCount || 0) + 1;
                        this.stats.totalVolume = (this.stats.totalVolume || 0) + size;

                        if (this.callbacks?.onTradeComplete) {
                            await this.callbacks.onTradeComplete({
                                id: Math.random().toString(36),
                                timestamp: new Date().toISOString(),
                                marketId: signal.marketId,
                                outcome: signal.outcome,
                                side: signal.side,
                                size: signal.sizeUsd,
                                executedSize: size,
                                price: signal.price,
                                status: 'CLOSED',
                                aiReasoning: reason,
                                riskScore: score
                            });
                        }
                        if(this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
                    }
                }
            }
        });

        await this.monitor.start(this.config.startCursor);
        this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000) as unknown as NodeJS.Timeout;

        await this.addLog('success', '🟢 Engine Online. Watching markets...');
    }

    private async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.client || this.activePositions.length === 0) return;
        
        const positionsToCheck = [...this.activePositions];
        
        for (const pos of positionsToCheck) {
            try {
                try {
                    const market = await getMarket(pos.marketId);
                    if ((market as any).closed || (market as any).active === false) {
                        this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                        if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                        continue;
                    }
                } catch (e) { continue; }
  
                const orderBook = await this.client.getOrderBook(pos.tokenId);
                if (orderBook.bids && orderBook.bids.length > 0) {
                    const bestBid = parseFloat(orderBook.bids[0].price);
                    const gainPercent = ((bestBid - pos.entryPrice) / pos.entryPrice) * 100;
                    
                    if (gainPercent >= this.config.autoTp) {
                        await this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} is up +${gainPercent.toFixed(1)}%`);
                        const success = await this.executor.executeManualExit(pos, bestBid);
                        if (success) {
                            this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                            if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                            
                            const realPnl = pos.sizeUsd * (gainPercent / 100);
                            this.stats.totalPnl = (this.stats.totalPnl || 0) + realPnl;
                            if(this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
                        }
                    }
                }
            } catch (e: any) { 
                 // Ignore
            }
        }
    }

    public stop() {
        this.isRunning = false;
        if (this.monitor) this.monitor.stop();
        if (this.fundWatcher) clearInterval(this.fundWatcher);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.addLog('info', '🔴 Engine Stopped.');
    }
}