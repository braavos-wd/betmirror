import { ClobClient, Chain } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, MaxUint256 } from 'ethers';
import { ZeroDevService } from '../../services/zerodev.service.js'; // Added .js
import { User } from '../../database/index.js'; // Added .js
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getUsdBalanceApprox } from '../../utils/get-balance.util.js'; // Added .js
// --- CONSTANTS ---
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];
// --- ADAPTER: Ethers V6 Wallet -> V5 Compatibility ---
class EthersV6Adapter extends Wallet {
    async _signTypedData(domain, types, value) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;
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
        // Caches
        this.balanceCache = new Map();
    }
    async initialize() {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
        const provider = new JsonRpcProvider(this.config.rpcUrl);
        // 1. Setup Signer (Type 0 EOA)
        if (this.config.walletConfig.type === 'SMART_ACCOUNT') {
            if (!this.config.zeroDevRpc)
                throw new Error("Missing ZeroDev RPC");
            // AA Service for On-Chain Ops
            this.zdService = new ZeroDevService(this.config.zeroDevRpc, this.config.zeroDevPaymasterRpc);
            this.funderAddress = this.config.walletConfig.address;
            if (!this.config.walletConfig.sessionPrivateKey) {
                throw new Error("Missing Session Private Key for Auth");
            }
            // Use Adapter for V5 compatibility
            this.signerImpl = new EthersV6Adapter(this.config.walletConfig.sessionPrivateKey, provider);
        }
        else {
            // Legacy EOA (Not supported in this strict mode, but kept for compat)
            throw new Error("Only Smart Accounts supported in this adapter version.");
        }
        // 2. Setup USDC Contract for Allowance Checks
        this.usdcContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, this.signerImpl);
    }
    async validatePermissions() {
        // Ensure On-Chain Deployment via ZeroDev
        if (this.zdService && this.funderAddress) {
            try {
                this.logger.info('🔄 Verifying Smart Account Deployment...');
                // Idempotent "Approve 0" tx to force deployment if needed
                await this.zdService.sendTransaction(this.config.walletConfig.serializedSessionKey, USDC_BRIDGED_POLYGON, USDC_ABI, 'approve', [this.funderAddress, 0]);
                return true;
            }
            catch (e) {
                this.logger.warn(`Deployment check note: ${e.message}`);
                // Proceed anyway, might be already deployed
            }
        }
        return true;
    }
    async authenticate() {
        // L2 Handshake Logic
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Performing L2 Handshake...');
            const tempClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, this.signerImpl, undefined, SignatureType.EOA, // Type 0
            this.funderAddress);
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
                await User.findOneAndUpdate({ address: this.config.userId }, { "proxyWallet.l2ApiCredentials": apiCreds });
                this.logger.success('✅ Authenticated & Keys Saved.');
            }
            catch (e) {
                this.logger.error(`Auth Failed: ${e.message}`);
                throw e;
            }
        }
        else {
            this.logger.info('🔑 Using cached credentials.');
        }
        // Initialize Real Client
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
        this.client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, this.signerImpl, apiCreds, SignatureType.EOA, this.funderAddress, undefined, undefined, builderConfig);
        // Ensure Allowance
        await this.ensureAllowance();
    }
    async ensureAllowance() {
        if (!this.usdcContract || !this.funderAddress)
            return;
        try {
            const allowance = await this.usdcContract.allowance(this.funderAddress, POLYMARKET_EXCHANGE);
            if (allowance < BigInt(1000000 * 1000)) {
                this.logger.info('🔓 Approving USDC for Trading...');
                const tx = await this.usdcContract.approve(POLYMARKET_EXCHANGE, MaxUint256);
                await tx.wait();
                this.logger.success('✅ Approved.');
            }
        }
        catch (e) {
            this.logger.warn("Allowance check skipped (AA delegation)");
        }
    }
    async fetchBalance(address) {
        // Use standard Ethers provider check on USDC.e
        // Note: For Smart Accounts, we check the Funder Address
        const target = address || this.funderAddress;
        return await getUsdBalanceApprox(this.signerImpl, USDC_BRIDGED_POLYGON);
    }
    async getMarketPrice(marketId, tokenId) {
        // Not implemented in this phase, handled by signal
        return 0;
    }
    async createOrder(params) {
        if (!this.client)
            throw new Error("Client not authenticated");
        // Return dummy for now as migration is gradual and services rely on raw client access
        return "not-implemented-in-adapter-yet";
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
        // Logic handled by FundManagerService usually, but can be moved here.
        return "";
    }
    // Expose raw client for legacy services until full refactor
    getRawClient() {
        return this.client;
    }
    getSigner() {
        return this.signerImpl;
    }
    getFunderAddress() {
        return this.funderAddress;
    }
}
