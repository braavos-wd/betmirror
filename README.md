
# Bet Mirror | Pro Cloud Terminal

![Bet Mirror Header](./docs/assets/header.png)

**Institutional-grade Polymarket Copy Trading Terminal. Features Non-Custodial Smart Accounts (ERC-4337), AI Risk Analysis (Gemini), and Cross-Chain funding via Li.Fi.**

**Bet Mirror Pro** is an enterprise-grade trading terminal designed to democratize algorithmic prediction market trading. Unlike traditional bots that require custodial private keys, Bet Mirror leverages **ERC-4337 Account Abstraction** to offer a fully non-custodial solution. Users retain full control of their funds while granting restricted "Session Keys" to a cloud-based engine that executes trades 24/7 based on **AI Risk Analysis** and **Copy Trading signals**. The platform includes a built-in "Alpha Registry" marketplace, rewarding top traders with a 1% protocol fee from every copier.

Developed by **PolyCafe**.

![License](https://img.shields.io/badge/license-Apache_2.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![React](https://img.shields.io/badge/React-18-blue)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-green)
![ZeroDev](https://img.shields.io/badge/ZeroDev-AA-purple)

---

## 🚀 How It Works

Bet Mirror Pro transforms complex algorithmic trading into a simple 3-step process for the end user.

### 1. The Smart Onboarding
- **Connect:** User connects their standard EOA (Metamask, Phantom, Rainbow).
- **Network Check:** The app will prompt you to switch to **Polygon** to sign the activation.
- **Deploy:** The app automatically deploys a **ZeroDev Smart Account** (Kernel v3.1) owned by your wallet.

### 2. The Cloud Engine (Server-Side)
- **Persistence:** Once the bot is started, it runs on our Node.js cloud cluster backed by **MongoDB**.
- **Offline Trading:** The user can close their browser or turn off their computer. The bot continues to monitor markets and execute trades 24/7.
- **AI Analysis:** Before every trade, the **Google Gemini 2.5** Agent analyzes the market question to ensure it aligns with the user's risk profile.

### 3. The Marketplace & Profit
- **Copy Trading:** Users browse the **Alpha Registry** to find whales with high win rates.
- **Fee Sharing:** When a user profits from a copied trade, a **1% fee** is automatically sent to the **Lister** (the user who found and listed the wallet) and **1%** to the Platform.
- **Trustless Withdraw:** Users can trigger a forced withdrawal from the dashboard at any time, bypassing the server entirely.

---

## 📈 Live Analytics Engine

The Alpha Marketplace is powered by a dedicated **Registry Analytics Service**.
*   **Real-Time Data:** The system fetches raw trade history from the Polymarket Data API.
*   **Win Rate Calculation:** Tracks "Round Trip" trades to calculate realized PnL.
*   **Auto-Update:** A background worker updates these stats every 15 minutes.

---

## 👷 Builder Program Integration

This platform is a registered **Polymarket Builder**. Every trade executed by the bot is cryptographically stamped with **Attribution Headers**.

---

## 🗺️ Roadmap

### Phase 1: Live Features (Complete)
- [x] Non-Custodial Smart Accounts
- [x] 24/7 Cloud Execution
- [x] Gemini AI Risk Analysis
- [x] Alpha Registry Marketplace

### Phase 2: Cross-Chain (Complete)
- [x] Li.Fi Bridge Integration (Solana/Base -> Polygon)

### Phase 3: Enterprise Data (Current)
- [x] MongoDB Persistence
- [x] System Metrics & Builder Attribution
- [x] Dual Volume Tracking (Signal vs. Execution)

### Phase 4: Trustless Automation (In Progress)
- [ ] **Smart Contract Fee Modules:** Move fee logic on-chain to downgrade Session Key permissions.
- [ ] **WebSocket Integration:** Replace polling with real-time CLOB sockets for sub-50ms latency.
- [ ] **On-Chain Registry:** Decentralize the Lister database.

See [Roadmap Phase 4](./docs/ROADMAP_PHASE_4.md) for details.

---

## ⚠️ Disclaimer

This software is for educational purposes only. Prediction markets involve risk. The "Trustless" architecture protects against server-side theft, but it does not protect against bad trading decisions or smart contract bugs. Use at your own risk.
