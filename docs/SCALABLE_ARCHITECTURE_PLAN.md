
# 🏛️ Scalable Trading Architecture Plan

**Objective:** Upgrade the Bet Mirror backend to support multiple prediction markets (Polymarket, Kalshi, PredictBase) while fixing current Polymarket authentication issues.

## 1. The Core Problem (RESOLVED)
The previous architecture struggled with Polymarket's strict EIP-1271 signature validation for Smart Accounts.
*   **Resolution:** We have implemented a **Hybrid Authentication Model**.
*   **Mechanism:** We use the `Session Private Key` (EOA) to sign standard messages/orders, while using the `Smart Account Address` as the "Funder". This satisfies Polymarket's requirements while maintaining the non-custodial security of ZeroDev.

## 2. Performance Upgrades (COMPLETED)

To handle high-frequency signals and ensure 24/7 reliability, we have applied the following optimizations:

### A. Memory Leak Prevention (`TradeMonitor`)
*   **Problem:** Storing every processed transaction hash in a `Set` indefinitely causes OOM crashes after weeks of runtime.
*   **Fix:** Implemented an **LRU (Least Recently Used)** pruning strategy using a `Map<Hash, Timestamp>`. Hashes older than the aggregation window (5 mins) are automatically removed.

### B. Latency Reduction (`TradeExecutor`)
*   **Problem:** Fetching a whale's portfolio balance takes 300ms-800ms via HTTP. Doing this *before* every trade slows down execution.
*   **Fix:** Implemented **WhaleBalanceCache**. We cache balance data for 5 minutes. Subsequent signals from the same whale execute instantly without waiting for the Data API.

### C. RPC Rate Limit Protection (`FundManager`)
*   **Problem:** Checking the blockchain balance every few seconds burns through RPC credits and can trigger IP bans.
*   **Fix:** Implemented **Throttling**. The Auto-Cashout logic now only runs once per hour (or upon specific trigger events), reducing RPC load by 99%.

## 3. The Solution: Exchange Adapter Pattern (NEXT PHASE)

We will abstract the specific logic of each exchange into **Adapters**. The `BotEngine` will no longer know it is trading on Polymarket; it will trade via a generic interface.

### A. The Interface (`IExchangeAdapter`)

Every market integration must implement this contract:

```typescript
export interface IExchangeAdapter {
    readonly exchangeName: string;
    
    // Lifecycle
    initialize(): Promise<void>;
    
    // Auth & Setup
    validatePermissions(): Promise<boolean>;
    authenticate(): Promise<void>;
    
    // Market Data
    fetchBalance(address: string): Promise<number>;
    getMarketPrice(marketId: string, tokenId: string): Promise<number>;
    
    // Execution
    createOrder(params: OrderParams): Promise<string>; // Returns Order ID / Tx Hash
    cancelOrder(orderId: string): Promise<boolean>;
    
    // Order Management
    cashout(amount: number, destination: string): Promise<string>;
}
```

### B. Polymarket Implementation (`PolymarketAdapter`)

This adapter will encapsulate the specific EOA/Session Key logic we identified as the fix.

*   **Signer:** Uses `ethers.Wallet` (EOA) initialized with the **Session Private Key**.
*   **Funder:** Uses the **Smart Account Address** (Proxy) as the `funderAddress`.
*   **Auth:** Performs the `createOrDeriveApiKey` handshake using SignatureType 0 (EOA).
*   **Gas:** Manages the ZeroDev Paymaster headers internally.

### C. Future Scaling (Kalshi Example)

When we add Kalshi, we simply create `KalshiAdapter`:

*   **Signer:** Uses `KALSHI_API_KEY` and `KALSHI_API_SECRET`.
*   **Funder:** N/A (Custodial/KYC account).
*   **Auth:** Direct HTTP Basic Auth or Bearer Token.
