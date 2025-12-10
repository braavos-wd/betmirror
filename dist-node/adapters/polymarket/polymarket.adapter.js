import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { ZeroDevService } from '../../services/zerodev.service.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
// --- CONSTANTS ---
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const HOST_URL = 'https://clob.polymarket.com';
// DEDICATED STATIC RESIDENTIAL PROXY
const PROXY_URL = 'http://toagonef:1t19is7izars@142.111.48.253:7030';
// Browser Fingerprint
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Referer': 'https://polymarket.com/',
    'Origin': 'https://polymarket.com',
    'Connection': 'keep-alive'
};
const USDC_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)'
];
// Adapter to make Ethers v6 Wallet compatible with ClobClient requirements
class EthersV6Adapter extends Wallet {
    async _signTypedData(domain, types, value) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;
        // Ensure chainId is number for EIP-712 domain matching
        if (domain.chainId)
            domain.chainId = Number(domain.chainId);
        return this.signTypedData(domain, cleanTypes, value);
    }
}
var SignatureType;
(function (SignatureType) {
    SignatureType[SignatureType["EOA"] = 0] = "EOA";
    SignatureType[SignatureType["POLY_PROXY"] = 1] = "POLY_PROXY";
    SignatureType[SignatureType["POLY_GNOSIS_SAFE"] = 2] = "POLY_GNOSIS_SAFE";
})(SignatureType || (SignatureType = {}));
export class PolymarketAdapter {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.exchangeName = 'Polymarket';
    }
    async initialize() {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (Dedicated Proxy Mode)...`);
        const provider = new JsonRpcProvider(this.config.rpcUrl);
        if (this.config.walletConfig.type === 'SMART_ACCOUNT') {
            if (!this.config.zeroDevRpc)
                throw new Error("Missing ZeroDev RPC");
            this.zdService = new ZeroDevService(this.config.zeroDevRpc, this.config.zeroDevPaymasterRpc);
            this.funderAddress = this.config.walletConfig.address;
            if (!this.config.walletConfig.sessionPrivateKey) {
                throw new Error("Missing Session Private Key for Auth");
            }
            this.signerImpl = new EthersV6Adapter(this.config.walletConfig.sessionPrivateKey, provider);
        }
        else {
            throw new Error("Only Smart Accounts supported in this adapter version.");
        }
        this.usdcContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, this.signerImpl);
    }
    async validatePermissions() {
        if (this.zdService && this.funderAddress) {
            try {
                this.logger.info('🔄 Verifying Smart Account Deployment...');
                await this.zdService.sendTransaction(this.config.walletConfig.serializedSessionKey, USDC_BRIDGED_POLYGON, USDC_ABI, 'approve', [this.funderAddress, 0]);
                this.logger.success('✅ Smart Account Ready.');
                return true;
            }
            catch (e) {
                this.logger.error(`Deployment Failed: ${e.message}`);
                throw new Error("Smart Account deployment failed. Check funds or network.");
            }
        }
        return true;
    }
    // Inject Dedicated Proxy Agent + Browser Headers into Client
    applyProxy(client) {
        try {
            const agent = new HttpsProxyAgent(PROXY_URL);
            const patchInstance = (instance) => {
                if (!instance)
                    return;
                // 1. Set Proxy Agent
                instance.defaults.httpsAgent = agent;
                instance.defaults.proxy = false;
                // 2. Overwrite Headers (Critical for Cloudflare)
                if (!instance.defaults.headers)
                    instance.defaults.headers = {};
                Object.assign(instance.defaults.headers, BROWSER_HEADERS);
                Object.assign(instance.defaults.headers.common, BROWSER_HEADERS);
            };
            // Patch known internal axios locations
            patchInstance(client.axiosInstance);
            patchInstance(client.httpClient);
            this.logger.info("🛡️ Dedicated Proxy + Stealth Headers Injected");
        }
        catch (e) {
            this.logger.warn("Failed to inject proxy into SDK");
        }
    }
    async authenticate() {
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Performing L2 Handshake...');
            const tempClient = new ClobClient(HOST_URL, Chain.POLYGON, this.signerImpl, undefined, SignatureType.EOA, this.funderAddress);
            this.applyProxy(tempClient);
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
                await User.findOneAndUpdate({ address: this.config.userId }, { "proxyWallet.l2ApiCredentials": apiCreds });
                this.logger.success('✅ Authenticated & Keys Saved.');
            }
            catch (e) {
                this.logger.error(`Auth Failed: ${e.message}`);
                throw e;
            }
        }
        else {
            this.logger.info('🔌 Connecting to CLOB...');
        }
        let builderConfig;
        if (this.config.builderApiKey) {
            builderConfig = new BuilderConfig({
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret,
                    passphrase: this.config.builderApiPassphrase
                }
            });
        }
        // Use raw creds - SDK v4 handles its own normalization usually
        this.client = new ClobClient(HOST_URL, Chain.POLYGON, this.signerImpl, apiCreds, SignatureType.EOA, this.funderAddress, undefined, undefined, builderConfig);
        this.applyProxy(this.client);
        await this.ensureAllowance();
    }
    async ensureAllowance() {
        if (!this.usdcContract || !this.funderAddress)
            return;
        try {
            const publicProvider = new JsonRpcProvider("https://polygon-rpc.com");
            const readContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, publicProvider);
            const allowance = await readContract.allowance(this.funderAddress, POLYMARKET_EXCHANGE);
            this.logger.info(`🔍 Allowance Check: ${formatUnits(allowance, 6)} USDC Approved for Exchange`);
            if (allowance < BigInt(1000000 * 1000)) {
                this.logger.info('🔓 Approving USDC for CTF Exchange...');
                if (this.zdService) {
                    const txHash = await this.zdService.sendTransaction(this.config.walletConfig.serializedSessionKey, USDC_BRIDGED_POLYGON, USDC_ABI, 'approve', [POLYMARKET_EXCHANGE, MaxUint256]);
                    this.logger.success(`✅ Approved. Tx: ${txHash}`);
                }
            }
            else {
                this.logger.info('✅ Allowance Sufficient.');
            }
        }
        catch (e) {
            this.logger.error(`Allowance Check Failed: ${e.message}`);
            throw new Error(`Failed to approve USDC. Bot cannot trade. Error: ${e.message}`);
        }
    }
    async fetchBalance(address) {
        if (!this.usdcContract)
            return 0;
        try {
            const balanceBigInt = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(balanceBigInt, 6));
        }
        catch (e) {
            return 0;
        }
    }
    async getMarketPrice(marketId, tokenId) {
        if (!this.client)
            return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        }
        catch (e) {
            return 0;
        }
    }
    async getOrderBook(tokenId) {
        if (!this.client)
            throw new Error("Client not authenticated");
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        };
    }
    async fetchPublicTrades(address, limit = 20) {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            // Use dedicated proxy with spoofed headers
            const agent = new HttpsProxyAgent(PROXY_URL);
            const res = await axios.get(url, {
                httpsAgent: agent,
                proxy: false,
                headers: BROWSER_HEADERS
            });
            if (!res.data || !Array.isArray(res.data))
                return [];
            const trades = [];
            for (const act of res.data) {
                if (act.type === 'TRADE' || act.type === 'ORDER_FILLED') {
                    const activityTime = typeof act.timestamp === 'number' ? act.timestamp : Math.floor(new Date(act.timestamp).getTime() / 1000);
                    trades.push({
                        trader: address,
                        marketId: act.conditionId,
                        tokenId: act.asset,
                        outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                        side: act.side.toUpperCase(),
                        sizeUsd: act.usdcSize || (act.size * act.price),
                        price: act.price,
                        timestamp: activityTime * 1000,
                    });
                }
            }
            return trades;
        }
        catch (e) {
            return [];
        }
    }
    async createOrder(params) {
        if (!this.client)
            throw new Error("Client not authenticated");
        const isBuy = params.side === 'BUY';
        const orderSide = isBuy ? Side.BUY : Side.SELL;
        let remaining = params.sizeUsd;
        let retryCount = 0;
        const maxRetries = 3;
        let lastOrderId = "";
        while (remaining >= 0.50 && retryCount < maxRetries) {
            try {
                const currentOrderBook = await this.client.getOrderBook(params.tokenId);
                const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;
                if (!currentLevels || currentLevels.length === 0) {
                    if (retryCount === 0)
                        throw new Error("No liquidity in orderbook");
                    break;
                }
                const level = currentLevels[0];
                const levelPrice = parseFloat(level.price);
                if (isBuy && params.priceLimit && levelPrice > params.priceLimit)
                    break;
                if (!isBuy && params.priceLimit && levelPrice < params.priceLimit)
                    break;
                let orderSize;
                let orderValue;
                if (isBuy) {
                    const levelValue = parseFloat(level.size) * levelPrice;
                    orderValue = Math.min(remaining, levelValue);
                    orderSize = orderValue / levelPrice;
                }
                else {
                    const levelValue = parseFloat(level.size) * levelPrice;
                    orderValue = Math.min(remaining, levelValue);
                    orderSize = orderValue / levelPrice;
                }
                orderSize = Math.floor(orderSize * 100) / 100;
                if (orderSize <= 0)
                    break;
                const orderArgs = {
                    tokenID: params.tokenId,
                    side: orderSide,
                    price: levelPrice,
                    size: orderSize,
                    feeRateBps: 0,
                    orderType: OrderType.FOK
                };
                const response = await this.client.createAndPostOrder(orderArgs);
                if (response.success && response.orderID) {
                    remaining -= orderValue;
                    retryCount = 0;
                    lastOrderId = response.orderID;
                }
                else {
                    const errMsg = response.errorMsg || 'Unknown Relayer Error';
                    this.logger.error(`❌ Exchange Rejection: ${errMsg}`);
                    if (errMsg.toLowerCase().includes("proxy") || errMsg.toLowerCase().includes("allowance")) {
                        this.logger.warn("Triggering emergency allowance check...");
                        await this.ensureAllowance();
                    }
                    retryCount++;
                }
            }
            catch (error) {
                this.logger.error(`Order attempt error: ${error.message}`);
                retryCount++;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        return lastOrderId || "failed";
    }
    async cancelOrder(orderId) {
        if (!this.client)
            return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        }
        catch (e) {
            return false;
        }
    }
    async cashout(amount, destination) {
        if (!this.zdService || !this.funderAddress) {
            throw new Error("Smart Account service not initialized");
        }
        this.logger.info(`💸 Adapters initiating cashout of $${amount} to ${destination}`);
        const amountUnits = parseUnits(amount.toFixed(6), 6);
        const txHash = await this.zdService.sendTransaction(this.config.walletConfig.serializedSessionKey, USDC_BRIDGED_POLYGON, USDC_ABI, 'transfer', [destination, amountUnits]);
        return txHash;
    }
    getRawClient() { return this.client; }
    getSigner() { return this.signerImpl; }
    getFunderAddress() { return this.funderAddress; }
}
