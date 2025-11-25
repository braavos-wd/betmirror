
export type RuntimeEnv = {
  userAddresses: string[];
  proxyWallet: string;
  privateKey: string;
  rpcUrl: string;
  fetchIntervalSeconds: number;
  tradeMultiplier: number;
  retryLimit: number;
  aggregationEnabled: boolean;
  aggregationWindowSeconds: number;
  usdcContractAddress: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  
  // The Global Registry (The "Backend" that tracks who listed what)
  registryApiUrl: string;

  // Revenue & Admin
  adminRevenueWallet: string;

  // Automation
  mainWalletAddress?: string;
  maxRetentionAmount?: number;
  enableAutoCashout: boolean;
  
  // Notifications
  enableNotifications: boolean;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  userPhoneNumber?: string;

  // Account Abstraction
  zeroDevRpc?: string;
  zeroDevProjectId?: string;
};

export function loadEnv(): RuntimeEnv {
  const parseList = (val: string | undefined): string[] => {
    if (!val) return [];
    try {
      const maybeJson = JSON.parse(val);
      if (Array.isArray(maybeJson)) return maybeJson.map(String);
    } catch (_) {
      // not JSON, parse as comma separated
    }
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  // Removed the strict 'required' check function to allow graceful startup without .env
  
  const userAddresses = parseList(process.env.USER_ADDRESSES);

  const env: RuntimeEnv = {
    userAddresses,
    // Allow empty strings. Main.ts will handle the check.
    proxyWallet: process.env.PUBLIC_KEY || '', 
    privateKey: process.env.PRIVATE_KEY || '',
    
    rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
    fetchIntervalSeconds: Number(process.env.FETCH_INTERVAL ?? 1),
    tradeMultiplier: Number(process.env.TRADE_MULTIPLIER ?? 1.0),
    retryLimit: Number(process.env.RETRY_LIMIT ?? 3),
    aggregationEnabled: String(process.env.TRADE_AGGREGATION_ENABLED ?? 'false') === 'true',
    aggregationWindowSeconds: Number(process.env.TRADE_AGGREGATION_WINDOW_SECONDS ?? 300),
    usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    
    // Default to localhost for dev, but this should be your deployed server URL
    registryApiUrl: process.env.REGISTRY_API_URL || 'http://localhost:3000/api',

    adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0xAdminRevenueWalletHere',

    // Automation
    mainWalletAddress: process.env.MAIN_WALLET_ADDRESS,
    maxRetentionAmount: process.env.MAX_RETENTION_AMOUNT ? Number(process.env.MAX_RETENTION_AMOUNT) : undefined,
    enableAutoCashout: String(process.env.ENABLE_AUTO_CASHOUT ?? 'false') === 'true',
    
    // Notifications
    enableNotifications: String(process.env.ENABLE_NOTIFICATIONS ?? 'false') === 'true',
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
    userPhoneNumber: process.env.USER_PHONE_NUMBER,

    // AA
    zeroDevRpc: process.env.ZERODEV_RPC || 'https://rpc.zerodev.app/api/v2/bundler/your-project-id',
    zeroDevProjectId: process.env.ZERODEV_PROJECT_ID
  };

  return env;
}