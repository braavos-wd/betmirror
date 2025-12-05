
import { Contract, formatUnits, formatEther } from 'ethers';
import type { Wallet, AbstractSigner, Provider } from 'ethers';

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

/**
 * Gets USDC balance. Supports both Ethers Wallet and AbstractSigner (like ZeroDev).
 */
export async function getUsdBalanceApprox(
  signer: Wallet | AbstractSigner | any,
  usdcContractAddress: string,
): Promise<number> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error('Wallet/Signer provider is required');
  }
  
  // Safely resolve address: Check property first, then fallback to async method
  const address = signer.address || (await signer.getAddress());

  const usdcContract = new Contract(usdcContractAddress, USDC_ABI, provider);
  const balance = await usdcContract.balanceOf(address);
  return parseFloat(formatUnits(balance, 6));
}

/**
 * Gets Native Token (POL/ETH) balance. Supports both Ethers Wallet and AbstractSigner.
 */
export async function getPolBalance(signer: Wallet | AbstractSigner | any): Promise<number> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error('Wallet/Signer provider is required');
  }
  
  // Safely resolve address
  const address = signer.address || (await signer.getAddress());
  
  const balance = await provider.getBalance(address);
  return parseFloat(formatEther(balance));
}
