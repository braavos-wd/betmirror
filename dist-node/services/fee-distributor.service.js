import { Contract, parseUnits } from 'ethers';
import { alphaRegistry } from './alpha-registry.service.js';
const USDC_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
];
export class FeeDistributorService {
    constructor(wallet, env, logger) {
        this.wallet = wallet;
        this.env = env;
        this.logger = logger;
        this.usdcContract = new Contract(env.usdcContractAddress, USDC_ABI, wallet);
        // Ensure the registry client knows where to look
        if (env.registryApiUrl) {
            alphaRegistry.setApiUrl(env.registryApiUrl);
        }
    }
    /**
     * Distributes 1% fee to the 'Finder' (Lister) and 1% to the Admin Platform.
     */
    async distributeFeesOnProfit(tradeId, netProfitUsdc, traderAddressWeCopied) {
        if (netProfitUsdc <= 0)
            return null;
        // 1. Lookup Lister
        const listerAddress = await alphaRegistry.getListerForWallet(traderAddressWeCopied);
        if (!listerAddress) {
            // No lister means no fee for them. We might still pay admin fee, 
            // but for this logic we'll skip if no registry entry found to keep it simple.
            return null;
        }
        // 2. Calculate Shares (1% each)
        const feePercentage = 0.01;
        const listerShare = netProfitUsdc * feePercentage;
        const platformShare = netProfitUsdc * feePercentage;
        // Dust protection ($0.01 minimum)
        if (listerShare < 0.01)
            return null;
        this.logger.info(`💸 Distributing Fees on $${netProfitUsdc} Profit:`);
        this.logger.info(`   -> Finder (${listerAddress.slice(0, 6)}): $${listerShare.toFixed(2)}`);
        this.logger.info(`   -> Platform: $${platformShare.toFixed(2)}`);
        try {
            // 3. Execute Transfers (Parallel)
            const listerTxPromise = this.usdcContract.transfer(listerAddress, parseUnits(listerShare.toFixed(6), 6));
            const adminTxPromise = this.usdcContract.transfer(this.env.adminRevenueWallet, parseUnits(platformShare.toFixed(6), 6));
            const [listerTx, adminTx] = await Promise.all([listerTxPromise, adminTxPromise]);
            this.logger.info(`   ✅ Fees Sent. Tx: ${listerTx.hash}`);
            return {
                tradeId,
                profitAmount: netProfitUsdc,
                listerFee: listerShare,
                platformFee: platformShare,
                listerAddress,
                platformAddress: this.env.adminRevenueWallet,
                txHash: listerTx.hash,
                timestamp: new Date().toISOString()
            };
        }
        catch (error) {
            this.logger.error(`Failed to distribute fees`, error);
            return null;
        }
    }
}
