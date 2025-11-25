import { BrowserProvider, Contract, parseUnits } from 'ethers';
import { createWalletClient, custom } from 'viem';
import { polygon } from 'viem/chains';
export const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const USDC_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)'
];
export class Web3Service {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.viemClient = null;
    }
    async connect() {
        if (!window.ethereum) {
            throw new Error("No wallet found. Please install MetaMask or Phantom.");
        }
        this.provider = new BrowserProvider(window.ethereum);
        await this.provider.send("eth_requestAccounts", []);
        this.signer = await this.provider.getSigner();
        return await this.signer.getAddress();
    }
    /**
     * Returns a Viem Wallet Client (Required for ZeroDev / AA)
     */
    async getViemWalletClient() {
        if (!this.viemClient) {
            if (!window.ethereum)
                throw new Error("No Wallet");
            const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
            this.viemClient = createWalletClient({
                account,
                chain: polygon, // Default to Polygon for AA setup
                transport: custom(window.ethereum)
            });
        }
        return this.viemClient;
    }
    async switchToChain(chainId) {
        if (!this.provider)
            await this.connect();
        const hexChainId = "0x" + chainId.toString(16);
        try {
            await this.provider.send("wallet_switchEthereumChain", [{ chainId: hexChainId }]);
        }
        catch (switchError) {
            // Error 4902: Chain not added. Add it.
            if (switchError.code === 4902) {
                const chainConfig = this.getChainConfig(chainId);
                if (chainConfig) {
                    await this.provider.send("wallet_addEthereumChain", [chainConfig]);
                }
            }
        }
    }
    async deposit(toAddress, amount) {
        if (!this.signer)
            await this.connect();
        // Ensure we are on Polygon for direct deposit
        await this.switchToChain(137);
        const usdc = new Contract(USDC_POLYGON, USDC_ABI, this.signer);
        const decimals = await usdc.decimals();
        const amountUnits = parseUnits(amount, decimals);
        const tx = await usdc.transfer(toAddress, amountUnits);
        await tx.wait();
        return tx.hash;
    }
    getChainConfig(chainId) {
        // Basic configs for popular chains
        if (chainId === 137)
            return {
                chainId: "0x89",
                chainName: "Polygon Mainnet",
                nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
                rpcUrls: ["https://polygon-rpc.com/"],
                blockExplorerUrls: ["https://polygonscan.com/"]
            };
        if (chainId === 56)
            return {
                chainId: "0x38",
                chainName: "BNB Smart Chain",
                nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                rpcUrls: ["https://bsc-dataseed.binance.org/"],
                blockExplorerUrls: ["https://bscscan.com/"]
            };
        if (chainId === 8453)
            return {
                chainId: "0x2105",
                chainName: "Base Mainnet",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://mainnet.base.org"],
                blockExplorerUrls: ["https://basescan.org"]
            };
        return null;
    }
}
export const web3Service = new Web3Service();
