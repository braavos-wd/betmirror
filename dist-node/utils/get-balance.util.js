import { Contract, formatUnits, formatEther } from 'ethers';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
export async function getUsdBalanceApprox(wallet, usdcContractAddress) {
    const provider = wallet.provider;
    if (!provider) {
        throw new Error('Wallet provider is required');
    }
    const usdcContract = new Contract(usdcContractAddress, USDC_ABI, provider);
    const balance = await usdcContract.balanceOf(wallet.address);
    return parseFloat(formatUnits(balance, 6));
}
export async function getPolBalance(wallet) {
    const provider = wallet.provider;
    if (!provider) {
        throw new Error('Wallet provider is required');
    }
    const balance = await provider.getBalance(wallet.address);
    return parseFloat(formatEther(balance));
}
