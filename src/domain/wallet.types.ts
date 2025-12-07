
export type WalletType = 'SMART_ACCOUNT';

export interface L2ApiCredentials {
    key: string;        // Client expects 'key'
    secret: string;     // Client expects 'secret'
    passphrase: string;
}

export interface ProxyWalletConfig {
  address: string;
  type: WalletType;
  
  // Account Abstraction Fields
  serializedSessionKey: string; 
  sessionPrivateKey?: string; 
  ownerAddress: string; 
  createdAt: string;

  // L2 Auth (Trading) Credentials
  l2ApiCredentials?: L2ApiCredentials;
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  formatted: string;
}
