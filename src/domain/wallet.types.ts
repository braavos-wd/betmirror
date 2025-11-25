
export type WalletType = 'SMART_ACCOUNT';

export interface ProxyWalletConfig {
  address: string;
  type: WalletType;
  
  // Account Abstraction Fields
  serializedSessionKey: string; // The session key string provided by ZeroDev
  sessionPrivateKey?: string; // Optional: Server doesn't need to persist this if using serialized, but good for debugging
  ownerAddress: string; // The EOA that controls this smart account
  createdAt: string;
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  formatted: string;
}
