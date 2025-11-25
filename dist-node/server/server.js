import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotEngine } from './bot-engine.js';
import 'dotenv/config';
// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR))
    fs.mkdirSync(DB_DIR);
const USERS_FILE = path.join(DB_DIR, 'users.json');
const REGISTRY_FILE = path.join(DB_DIR, 'registry.json');
const FEEDBACK_FILE = path.join(DB_DIR, 'feedback.json');
const ACTIVE_BOTS = new Map();
app.use(cors());
app.use(express.json());
// --- PERSISTENCE ---
function loadUsers() {
    if (fs.existsSync(USERS_FILE))
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    return {};
}
function saveUser(userId, data) {
    const users = loadUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function getUser(userId) {
    const users = loadUsers();
    return users[userId];
}
// REGISTRY PERSISTENCE
let WALLET_REGISTRY = [];
function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_FILE)) {
            WALLET_REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
        }
        else {
            WALLET_REGISTRY = [
                { address: '0x8894e0a0c962cb723c1976a4421c95949be2d4e3', ens: 'vitalik.eth', winRate: 82.5, totalPnl: 450200, tradesLast30d: 12, followers: 15400, isVerified: true, listedBy: '0xSatoshi', listedAt: '2023-01-01', copyCount: 124, copyProfitGenerated: 54000 },
            ];
            saveRegistry();
        }
    }
    catch (e) {
        console.error('Registry Load Error', e);
    }
}
function saveRegistry() {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(WALLET_REGISTRY, null, 2));
}
loadRegistry();
// --- API ---
// 1. Check Status / Init
app.post('/api/wallet/status', (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'User Address required' });
        return;
    }
    const user = getUser(userId);
    if (!user || !user.proxyWallet) {
        res.json({ status: 'NEEDS_ACTIVATION' });
    }
    else {
        res.json({
            status: 'ACTIVE',
            address: user.proxyWallet.address,
            type: 'SMART_ACCOUNT'
        });
    }
});
// 2. Activate Smart Account
app.post('/api/wallet/activate', (req, res) => {
    const { userId, serializedSessionKey, smartAccountAddress } = req.body;
    if (!userId || !serializedSessionKey || !smartAccountAddress) {
        res.status(400).json({ error: 'Missing activation parameters' });
        return;
    }
    const walletConfig = {
        type: 'SMART_ACCOUNT',
        address: smartAccountAddress,
        serializedSessionKey: serializedSessionKey,
        ownerAddress: userId,
        createdAt: new Date().toISOString()
    };
    saveUser(userId, { proxyWallet: walletConfig });
    console.log(`[ACTIVATION] Smart Account Activated: ${smartAccountAddress} (Owner: ${userId})`);
    res.json({ success: true, address: smartAccountAddress });
});
// 3. Global Stats (System Page)
app.get('/api/stats/global', (req, res) => {
    const users = loadUsers();
    const userCount = Object.keys(users).length;
    let totalVolume = 0;
    let totalRevenue = 0; // Our 1% share
    let totalBridged = 0; // Mock for now, or aggregate from user logs
    // Aggregate User Stats
    Object.values(users).forEach((u) => {
        if (u.stats) {
            totalVolume += (u.stats.totalVolume || 0);
        }
        // Revenue approximation (assuming 1% of PnL or Volume based on model)
        // Here we just use a mock multiplier for demo of the "System" page
        totalRevenue += (u.stats.totalFeesPaid || 0);
    });
    // Add Registry generated stats
    WALLET_REGISTRY.forEach(w => {
        totalRevenue += (w.copyProfitGenerated * 0.01); // 1% of copy profit
    });
    res.json({
        totalUsers: userCount,
        totalVolume,
        totalRevenue,
        totalBridged: totalBridged + 125000, // + Mock baseline
        activeBots: ACTIVE_BOTS.size
    });
});
// 4. Feedback System
app.post('/api/feedback', (req, res) => {
    const { userId, rating, comment } = req.body;
    let feedbacks = [];
    if (fs.existsSync(FEEDBACK_FILE)) {
        feedbacks = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
    }
    feedbacks.push({ userId, rating, comment, timestamp: new Date().toISOString() });
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2));
    res.json({ success: true });
});
app.post('/api/bot/start', async (req, res) => {
    const { userId, userAddresses, rpcUrl, geminiApiKey, multiplier, riskProfile, autoTp, notifications, autoCashout } = req.body;
    const user = getUser(userId);
    if (!user || !user.proxyWallet) {
        res.status(400).json({ error: 'Bot Wallet not activated. Please complete setup.' });
        return;
    }
    const config = {
        userId,
        walletConfig: user.proxyWallet,
        userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s) => s.trim()),
        rpcUrl,
        geminiApiKey,
        multiplier: Number(multiplier),
        riskProfile,
        autoTp: autoTp ? Number(autoTp) : undefined,
        enableNotifications: notifications?.enabled,
        userPhoneNumber: notifications?.phoneNumber,
        autoCashout: autoCashout,
        activePositions: user.activePositions || [],
        zeroDevRpc: process.env.ZERODEV_RPC
    };
    try {
        if (ACTIVE_BOTS.has(userId)) {
            ACTIVE_BOTS.get(userId)?.stop();
        }
        const engine = new BotEngine(config, {
            onPositionsUpdate: (positions) => saveUser(userId, { activePositions: positions }),
            onCashout: (record) => {
                const u = getUser(userId);
                const history = u.cashoutHistory || [];
                history.unshift(record);
                saveUser(userId, { cashoutHistory: history });
            },
            onTradeComplete: (trade) => {
                const u = getUser(userId);
                const h = u.tradeHistory || [];
                h.unshift(trade);
                saveUser(userId, { tradeHistory: h });
            },
            onStatsUpdate: (stats) => saveUser(userId, { stats }),
            onFeePaid: (event) => {
                const lister = WALLET_REGISTRY.find(w => w.listedBy.toLowerCase() === event.listerAddress.toLowerCase());
                if (lister) {
                    lister.copyCount = (lister.copyCount || 0) + 1;
                    lister.copyProfitGenerated = (lister.copyProfitGenerated || 0) + event.profitAmount;
                    saveRegistry();
                }
            }
        });
        ACTIVE_BOTS.set(userId, engine);
        await engine.start();
        saveUser(userId, { activeBotConfig: config, isBotRunning: true });
        res.json({ success: true, status: 'RUNNING' });
    }
    catch (e) {
        console.error("Failed to start bot:", e);
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/bot/stop', async (req, res) => {
    const { userId } = req.body;
    const engine = ACTIVE_BOTS.get(userId);
    if (engine)
        engine.stop();
    saveUser(userId, { isBotRunning: false });
    res.json({ success: true, status: 'STOPPED' });
});
app.get('/api/bot/status/:userId', (req, res) => {
    const { userId } = req.params;
    const engine = ACTIVE_BOTS.get(userId);
    if (engine) {
        res.json({
            isRunning: engine.isRunning,
            logs: engine.getLogs(),
            history: engine.getHistory(),
            stats: engine.getStats()
        });
    }
    else {
        const user = getUser(userId);
        res.json({
            isRunning: false,
            logs: [],
            history: user?.tradeHistory || [],
            stats: user?.stats || null
        });
    }
});
app.get('/api/registry', (req, res) => {
    res.json(WALLET_REGISTRY.sort((a, b) => b.winRate - a.winRate));
});
app.post('/api/registry', (req, res) => {
    const { address, listedBy } = req.body;
    if (!address || !address.startsWith('0x')) {
        res.status(400).json({ error: 'Invalid address' });
        return;
    }
    const existing = WALLET_REGISTRY.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (existing) {
        res.status(409).json({ error: 'Already listed', profile: existing });
        return;
    }
    const profile = {
        address, listedBy, listedAt: new Date().toISOString(),
        winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0
    };
    WALLET_REGISTRY.push(profile);
    saveRegistry();
    res.json({ success: true, profile });
});
async function restoreBots() {
    const users = loadUsers();
    for (const [userId, userData] of Object.entries(users)) {
        if (userData.isBotRunning && userData.activeBotConfig) {
            const config = { ...userData.activeBotConfig, walletConfig: userData.proxyWallet };
            const engine = new BotEngine(config, {
                onPositionsUpdate: (p) => saveUser(userId, { activePositions: p }),
                onStatsUpdate: (s) => saveUser(userId, { stats: s }),
                onTradeComplete: (t) => {
                    const h = userData.tradeHistory || [];
                    h.unshift(t);
                    saveUser(userId, { tradeHistory: h });
                }
            });
            ACTIVE_BOTS.set(userId, engine);
            engine.start();
        }
    }
}
app.listen(PORT, () => {
    console.log(`🌍 Bet Mirror Cloud Server running on port ${PORT}`);
    restoreBots();
});
