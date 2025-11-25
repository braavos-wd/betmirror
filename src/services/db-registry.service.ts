
import { Registry } from '../database/index.js';
import { IRegistryService } from '../domain/alpha.types.js';

/**
 * Server-side service to talk to the Registry via Mongoose.
 * Used by the BotEngine to avoid internal HTTP calls.
 */
export class DbRegistryService implements IRegistryService {
    async getListerForWallet(walletAddress: string): Promise<string | null> {
        try {
            // Case-insensitive regex search for address
            const profile = await Registry.findOne({ 
                address: { $regex: new RegExp(`^${walletAddress}$`, "i") } 
            });
            return profile ? profile.listedBy : null;
        } catch (e) {
            console.error("DbRegistry lookup failed", e);
            return null;
        }
    }
}
