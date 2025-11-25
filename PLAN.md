
# 🗺️ Bet Mirror Architecture Roadmap

This document outlines the migration path from the current **Custodial SaaS Model** to a **Non-Custodial Account Abstraction Model** with Cross-Chain capabilities.

## Phase 1: Current State (Managed SaaS)
- **Wallet:** EOA (Standard Private Key).
- **Custody:** Server holds private key in `users.json`.
- **Security:** "Trust me bro" model (Server promises not to withdraw).
- **Network:** Polygon Native only.

---

## Phase 2: Cross-Chain Onboarding (LiFi Integration)
**Goal:** Allow users to fund their bot from Solana, Base, BSC, or Mainnet.

### Architecture
1.  **Frontend Integration:**
    - Install `@lifi/sdk`.
    - Create `DepositWidget` component.
    - User selects "Source Chain" (e.g., Base) and "Amount".
2.  **Route Execution:**
    - Source: User's Wallet (Arbitrum/Base/Solana).
    - Destination: User's Proxy Wallet Address (Polygon).
    - LiFi handles the bridging and swapping to USDC.
3.  **Bot Awareness:**
    - Bot listens for incoming transfers on the Proxy Wallet to auto-update balances.

### Technical Tasks
- [ ] Implement `src/services/lifi.service.ts` (See stub).
- [ ] Update Frontend `handleDeposit` to use LiFi instead of direct Ethers tx.
- [ ] Add `liFiConfig` to `RuntimeEnv`.

---

## Phase 3: Account Abstraction (The "Trustless" Leap)
**Goal:** Remove server custody of funds. Server only holds "Trading Permissions".

### Architecture
1.  **Smart Accounts (Kernel / Safe):**
    - Instead of `Wallet.createRandom()`, we use an AA SDK (e.g., ZeroDev or Alchemy Account Kit).
    - The "Proxy Wallet" becomes a deployed Smart Contract.
2.  **Session Keys:**
    - User signs a session key off-chain.
    - Permissions: `Target: PolymarketExchange`, `Function: createOrder()`, `Limit: Only USDC`.
    - Server stores this Session Key, NOT the Admin Key.
3.  **Gas Abstraction (Paymaster):**
    - Users pay fees in USDC. The Paymaster handles MATIC gas fees invisibly.

### Technical Tasks
- [ ] Install AA SDK (ZeroDev/Permissionless.js).
- [ ] Refactor `BotEngine` to sign UserOps instead of Ethers Transactions.
- [ ] Create `SessionManager` on backend to track expiration of keys.

---

## Phase 4: Decentralized Registry
**Goal:** Move `registry.json` to an on-chain Smart Contract.
- Listers call `Registry.register(wallet)`.
- Copiers call `Registry.payFee()` (handled by bot).
- Removes the central server dependency for fee sharing.
