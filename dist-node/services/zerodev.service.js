import { createKernelAccount, createZeroDevPaymasterClient, createKernelAccountClient, } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { http, createPublicClient, encodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { deserializePermissionAccount, serializePermissionAccount, toPermissionValidator, } from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
// Constants
const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
const CHAIN = polygon;
// Default Public RPC (Polygon)
const PUBLIC_RPC = "https://polygon-rpc.com";
// --- GAS TOKEN CONFIGURATION ---
// User requested Native USDC for gas sponsoring.
// Native USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 (Circle)
// Bridged USDC.e: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (Polymarket)
const GAS_TOKEN_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// ERC20 Paymaster Address (Pimlico/ZeroDev Standard for Polygon)
const ERC20_PAYMASTER_ADDRESS = '0x0000000000325602a77414A841499c5613416D2d';
const USDC_ABI = parseAbi([
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)"
]);
export class ZeroDevService {
    constructor(zeroDevRpcUrlOrId, paymasterRpcUrl) {
        // 1. Bundler RPC (Standard)
        this.bundlerRpc = this.normalizeRpcUrl(zeroDevRpcUrlOrId);
        // 2. Paymaster RPC (Strict)
        // If a specific Paymaster URL is provided, use it EXACTLY as is, preserving params like ?selfFunded=true
        if (paymasterRpcUrl) {
            this.paymasterRpc = paymasterRpcUrl;
        }
        else {
            // Fallback to bundler URL if not specified
            this.paymasterRpc = this.bundlerRpc;
        }
        console.log(`[ZeroDev] Bundler: ${this.bundlerRpc}`);
        console.log(`[ZeroDev] Paymaster: ${this.paymasterRpc}`);
        this.publicClient = createPublicClient({
            chain: CHAIN,
            transport: http(PUBLIC_RPC),
        });
    }
    normalizeRpcUrl(input) {
        // Simple UUID check
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const match = input.match(uuidRegex);
        // If it looks like a full URL, keep it
        if (input.includes("http"))
            return input;
        // If it's just a project ID, construct the standard Bundler URL
        if (match) {
            return `https://rpc.zerodev.app/api/v3/${match[0]}/chain/137`;
        }
        return input;
    }
    /**
     * Universal UserOp Sender with Fallback Logic.
     * Auto-parses ABI if string array is provided.
     */
    async sendTransaction(serializedSessionKey, to, abi, functionName, args) {
        const sessionKeyAccount = await deserializePermissionAccount(this.publicClient, ENTRY_POINT, KERNEL_VERSION, serializedSessionKey);
        // FIX: Automatically parse Human Readable ABI (String Array) if detected
        const parsedAbi = (abi.length > 0 && typeof abi[0] === 'string')
            ? parseAbi(abi)
            : abi;
        const callData = encodeFunctionData({
            abi: parsedAbi,
            functionName,
            args
        });
        const userOpCallData = await sessionKeyAccount.encodeCalls([{
                to: to,
                value: BigInt(0),
                data: callData
            }]);
        const paymasterClient = createZeroDevPaymasterClient({
            chain: CHAIN,
            transport: http(this.paymasterRpc),
        });
        const kernelClient = createKernelAccountClient({
            account: sessionKeyAccount,
            chain: CHAIN,
            bundlerTransport: http(this.bundlerRpc),
            client: this.publicClient,
            paymaster: {
                getPaymasterData(userOperation) {
                    return paymasterClient.sponsorUserOperation({
                        userOperation,
                        gasToken: GAS_TOKEN_ADDRESS
                    });
                }
            }
        });
        // 1. Try with Paymaster (USDC Gas)
        try {
            console.log(`Attempting UserOp via ERC20 Paymaster...`);
            const userOpHash = await kernelClient.sendUserOperation({
                callData: userOpCallData
            });
            console.log("✅ Paymaster Success. UserOp:", userOpHash);
            return userOpHash;
        }
        catch (e) {
            console.warn(`⚠️ Paymaster Failed (${e.message}). Retrying with Native Gas (POL)...`);
        }
        // 2. Fallback: Native Gas (POL)
        const fallbackClient = createKernelAccountClient({
            account: sessionKeyAccount,
            chain: CHAIN,
            bundlerTransport: http(this.bundlerRpc),
            client: this.publicClient,
        });
        const userOpHash = await fallbackClient.sendUserOperation({
            callData: userOpCallData
        });
        console.log("✅ Native Gas Success. UserOp:", userOpHash);
        return userOpHash;
    }
    async getPaymasterApprovalCallData() {
        return encodeFunctionData({
            abi: USDC_ABI,
            functionName: "approve",
            args: [ERC20_PAYMASTER_ADDRESS, BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")]
        });
    }
    async computeMasterAccountAddress(ownerWalletClient) {
        try {
            if (!ownerWalletClient)
                throw new Error("Missing owner wallet client");
            const ecdsaValidator = await signerToEcdsaValidator(this.publicClient, {
                entryPoint: ENTRY_POINT,
                signer: ownerWalletClient,
                kernelVersion: KERNEL_VERSION,
            });
            const account = await createKernelAccount(this.publicClient, {
                entryPoint: ENTRY_POINT,
                plugins: { sudo: ecdsaValidator },
                kernelVersion: KERNEL_VERSION,
            });
            return account.address;
        }
        catch (e) {
            console.error("Failed to compute deterministic address (ZeroDev):", e.message);
            return null;
        }
    }
    async createSessionKeyForServer(ownerWalletClient, ownerAddress) {
        console.log("🔐 Generating Session Key...");
        const sessionPrivateKey = generatePrivateKey();
        const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);
        const sessionKeySigner = await toECDSASigner({ signer: sessionKeyAccount });
        const ecdsaValidator = await signerToEcdsaValidator(this.publicClient, {
            entryPoint: ENTRY_POINT,
            signer: ownerWalletClient,
            kernelVersion: KERNEL_VERSION,
        });
        const permissionPlugin = await toPermissionValidator(this.publicClient, {
            entryPoint: ENTRY_POINT,
            signer: sessionKeySigner,
            policies: [toSudoPolicy({})],
            kernelVersion: KERNEL_VERSION,
        });
        const sessionKeyAccountObj = await createKernelAccount(this.publicClient, {
            entryPoint: ENTRY_POINT,
            plugins: {
                sudo: ecdsaValidator,
                regular: permissionPlugin,
            },
            kernelVersion: KERNEL_VERSION,
        });
        const serializedSessionKey = await serializePermissionAccount(sessionKeyAccountObj, sessionPrivateKey);
        return {
            smartAccountAddress: sessionKeyAccountObj.address,
            serializedSessionKey: serializedSessionKey,
            sessionPrivateKey: sessionPrivateKey
        };
    }
    async createBotClient(serializedSessionKey) {
        const sessionKeyAccount = await deserializePermissionAccount(this.publicClient, ENTRY_POINT, KERNEL_VERSION, serializedSessionKey);
        const paymasterClient = createZeroDevPaymasterClient({
            chain: CHAIN,
            transport: http(this.paymasterRpc),
        });
        const kernelClient = createKernelAccountClient({
            account: sessionKeyAccount,
            chain: CHAIN,
            bundlerTransport: http(this.bundlerRpc),
            client: this.publicClient,
            paymaster: {
                getPaymasterData(userOperation) {
                    return paymasterClient.sponsorUserOperation({
                        userOperation,
                        gasToken: GAS_TOKEN_ADDRESS
                    });
                },
            },
        });
        return {
            address: sessionKeyAccount.address,
            client: kernelClient
        };
    }
    async withdrawFunds(ownerWalletClient, smartAccountAddress, toAddress, amount, tokenAddress) {
        console.log("Initiating Trustless Withdrawal...");
        const ecdsaValidator = await signerToEcdsaValidator(this.publicClient, {
            entryPoint: ENTRY_POINT,
            signer: ownerWalletClient,
            kernelVersion: KERNEL_VERSION,
        });
        const account = await createKernelAccount(this.publicClient, {
            entryPoint: ENTRY_POINT,
            plugins: { sudo: ecdsaValidator },
            kernelVersion: KERNEL_VERSION,
            address: smartAccountAddress,
        });
        const isNative = tokenAddress === '0x0000000000000000000000000000000000000000';
        let callData;
        let value = BigInt(0);
        let target;
        if (isNative) {
            callData = "0x";
            value = amount;
            target = toAddress;
        }
        else {
            callData = encodeFunctionData({
                abi: USDC_ABI,
                functionName: "transfer",
                args: [toAddress, amount]
            });
            target = tokenAddress;
        }
        const calls = [{ to: target, value, data: callData }];
        // Auto-approve Paymaster if needed
        if (!isNative && tokenAddress.toLowerCase() === GAS_TOKEN_ADDRESS.toLowerCase()) {
            const approveData = await this.getPaymasterApprovalCallData();
            calls.unshift({
                to: GAS_TOKEN_ADDRESS,
                value: BigInt(0),
                data: approveData
            });
        }
        const encodedCallData = await account.encodeCalls(calls);
        const paymasterClient = createZeroDevPaymasterClient({
            chain: CHAIN,
            transport: http(this.paymasterRpc),
        });
        const kernelClient = createKernelAccountClient({
            account,
            chain: CHAIN,
            bundlerTransport: http(this.bundlerRpc),
            client: this.publicClient,
            paymaster: {
                getPaymasterData(userOperation) {
                    return paymasterClient.sponsorUserOperation({
                        userOperation,
                        gasToken: GAS_TOKEN_ADDRESS
                    });
                }
            }
        });
        try {
            const userOpHash = await kernelClient.sendUserOperation({
                callData: encodedCallData,
            });
            const receipt = await this.publicClient.waitForTransactionReceipt({ hash: userOpHash });
            return receipt.transactionHash;
        }
        catch (e) {
            console.warn(`Withdraw Paymaster Failed, trying native gas: ${e.message}`);
            const fallbackClient = createKernelAccountClient({
                account,
                chain: CHAIN,
                bundlerTransport: http(this.bundlerRpc),
                client: this.publicClient,
            });
            const userOpHash = await fallbackClient.sendUserOperation({ callData: encodedCallData });
            const receipt = await this.publicClient.waitForTransactionReceipt({ hash: userOpHash });
            return receipt.transactionHash;
        }
    }
}
