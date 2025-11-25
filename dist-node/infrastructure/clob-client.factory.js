import { Wallet, JsonRpcProvider } from 'ethers';
import { ClobClient, Chain } from '@polymarket/clob-client';
export async function createPolymarketClient(input) {
    const provider = new JsonRpcProvider(input.rpcUrl);
    const wallet = new Wallet(input.privateKey, provider);
    let creds;
    if (input.apiKey && input.apiSecret && input.apiPassphrase) {
        creds = {
            key: input.apiKey,
            secret: input.apiSecret,
            passphrase: input.apiPassphrase,
        };
    }
    // Casting wallet as any to bypass type mismatch between ethers v6 Wallet and ClobClient (v5) expectation
    const client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, creds);
    return Object.assign(client, { wallet });
}
