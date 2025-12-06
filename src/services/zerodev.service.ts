
import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  http,
  Hex,
  createPublicClient,
  PublicClient,
  WalletClient,
  encodeFunctionData,
  parseAbi
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { TOKENS } from "../config/env.js";

const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
const CHAIN = polygon;
// Use a robust public RPC for read operations
const PUBLIC_RPC = "https://polygon-rpc.com";

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

export class ZeroDevService {
  public publicClient: PublicClient;
  private rpcUrl: string;
  private paymasterRpc: string;

  constructor(zeroDevRpcUrlOrId: string, paymasterRpcUrl?: string) {
    this.rpcUrl = this.normalizeRpcUrl(zeroDevRpcUrlOrId);
    // Use bundler URL as fallback if no paymaster URL is provided
    this.paymasterRpc = paymasterRpcUrl ? this.normalizeRpcUrl(paymasterRpcUrl) : this.rpcUrl;
    
    // Initialize the public client immediately
    this.publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(PUBLIC_RPC),
    }) as unknown as PublicClient;
    
    console.log(`[ZeroDev] Bundler Configured: ${this.rpcUrl.slice(0, 30)}...`);
  }

  /**
   * Aggressively normalizes V2 URLs to V3 to prevent 404s
   */
  private normalizeRpcUrl(input: string): string {
      if (!input) return input;
      
      // If it's just a UUID, wrap it in V3 format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(input)) {
           return `https://rpc.zerodev.app/api/v3/${input}/chain/137`;
      }

      // If it contains /v2/, upgrade it
      if (input.includes('/v2/')) {
         return input.replace('/v2/bundler/', '/v3/').replace('https://rpc.zerodev.app/api/v3/', 'https://rpc.zerodev.app/api/v3/') + '/chain/137';
      }
      
      return input;
  }

  async computeMasterAccountAddress(ownerWalletClient: WalletClient) {
      try {
          if (!ownerWalletClient) throw new Error("Missing owner wallet client");
          
          const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
              entryPoint: ENTRY_POINT,
              signer: ownerWalletClient as any,
              kernelVersion: KERNEL_VERSION,
          });

          const account = await createKernelAccount(this.publicClient as any, {
              entryPoint: ENTRY_POINT,
              plugins: { sudo: ecdsaValidator },
              kernelVersion: KERNEL_VERSION,
          });

          return account.address;
      } catch (e: any) {
          console.error("Failed to compute deterministic address:", e.message);
          return null;
      }
  }

  /**
   * Creates a session key and sends a UserOperation to enable it on-chain.
   * This ensures the bot server receives a valid, authorized key.
   */
  async createSessionKeyForServer(ownerWalletClient: WalletClient, ownerAddress: string) {
    console.log("🔐 Generating Session Key & Bootstrapping Account...");

    const sessionPrivateKey = generatePrivateKey();
    const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);
    const sessionKeySigner = await toECDSASigner({ signer: sessionKeyAccount });

    const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: ownerWalletClient as any, 
      kernelVersion: KERNEL_VERSION,
    });

    const permissionPlugin = await toPermissionValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: sessionKeySigner,
      policies: [ toSudoPolicy({}) ], 
      kernelVersion: KERNEL_VERSION,
    });

    const sessionKeyAccountObj = await createKernelAccount(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      plugins: {
        sudo: ecdsaValidator,
        regular: permissionPlugin,
      },
      kernelVersion: KERNEL_VERSION,
    });

    // --- BOOTSTRAP TRANSACTION ---
    // This sends a transaction on-chain to enable the session key permission.
    // Without this, the server cannot sign valid UserOps.
    console.log("🚀 Sending Session Key Enablement Tx (0.00 USDC Self-Transfer)...");
    try {
        const paymasterClient = createZeroDevPaymasterClient({
            chain: CHAIN,
            transport: http(this.paymasterRpc),
        });

        const kernelClient = createKernelAccountClient({
            account: sessionKeyAccountObj,
            chain: CHAIN,
            bundlerTransport: http(this.rpcUrl),
            client: this.publicClient as any,
            paymaster: {
                getPaymasterData(userOperation) {
                    return paymasterClient.sponsorUserOperation({ userOperation });
                },
            },
        });

        // 0-value self-transfer to trigger deployment and plugin install
        // Casting to any to avoid strict Viem type checks on transaction object
        const userOpHash = await kernelClient.sendTransaction({
            to: sessionKeyAccountObj.address,
            value: BigInt(0),
            data: "0x",
        } as any);

        console.log(`✅ Bootstrap UserOp Sent: ${userOpHash}`);
        
        // Blocking wait for receipt to ensure account exists before server tries to use it
        console.log("⏳ Waiting for indexing...");
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash: userOpHash });
        
        if (receipt.status === 'success') {
             console.log("🎉 Account Deployed & Session Key Enabled.");
        } else {
             console.error("⚠️ Bootstrap Tx Failed or Reverted.");
        }

    } catch (e: any) {
        console.warn("⚠️ Bootstrap Note: " + (e.message || "User may have rejected or account already active."));
    }

    const serializedSessionKey = await serializePermissionAccount(sessionKeyAccountObj, sessionPrivateKey);

    return {
      smartAccountAddress: sessionKeyAccountObj.address,
      serializedSessionKey: serializedSessionKey,
      sessionPrivateKey: sessionPrivateKey 
    };
  }

  /**
   * Creates the kernel client for the server to use (using the Session Key)
   */
  async createBotClient(serializedSessionKey: string) {
    const sessionKeyAccount = await deserializePermissionAccount(
      this.publicClient as any,
      ENTRY_POINT,
      KERNEL_VERSION,
      serializedSessionKey
    );

    const paymasterClient = createZeroDevPaymasterClient({
      chain: CHAIN,
      transport: http(this.paymasterRpc),
    });

    const kernelClient = createKernelAccountClient({
      account: sessionKeyAccount,
      chain: CHAIN,
      bundlerTransport: http(this.rpcUrl),
      client: this.publicClient as any,
      paymaster: {
        getPaymasterData(userOperation) {
          return paymasterClient.sponsorUserOperation({ userOperation });
        },
      },
    });

    return {
        address: sessionKeyAccount.address,
        client: kernelClient
    };
  }

  // --- WITHDRAWAL ---
  async withdrawFunds(ownerWalletClient: WalletClient, smartAccountAddress: string, toAddress: string, amount: bigint, tokenAddress: string) {
      const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
        entryPoint: ENTRY_POINT,
        signer: ownerWalletClient as any,
        kernelVersion: KERNEL_VERSION,
      });

      const account = await createKernelAccount(this.publicClient as any, {
        entryPoint: ENTRY_POINT,
        plugins: { sudo: ecdsaValidator },
        kernelVersion: KERNEL_VERSION,
        address: smartAccountAddress as Hex,
      });
      
      const paymasterClient = createZeroDevPaymasterClient({
        chain: CHAIN,
        transport: http(this.paymasterRpc),
      });

      const kernelClient = createKernelAccountClient({
        account,
        chain: CHAIN,
        bundlerTransport: http(this.rpcUrl),
        client: this.publicClient as any,
        paymaster: {
          getPaymasterData(userOperation) {
             return paymasterClient.sponsorUserOperation({ userOperation });
          }
        }
      });

      let callData: Hex;
      let target: Hex;
      let value: bigint;

      if (tokenAddress === TOKENS.POL) {
          target = toAddress as Hex;
          value = amount;
          callData = "0x";
      } else {
          target = tokenAddress as Hex;
          value = BigInt(0);
          callData = encodeFunctionData({
              abi: USDC_ABI,
              functionName: "transfer",
              args: [toAddress as Hex, amount]
          });
      }

      // Cast to any to resolve TypeScript complaints about kzg/eip1559 parameters
      const txHash = await kernelClient.sendTransaction({
        to: target,
        value: value,
        data: callData,
      } as any);

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      return receipt.transactionHash;
  }
}
