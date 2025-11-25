import axios from 'axios';
/**
 * Client-side service to talk to the Global Registry API.
 * No simulation. Real HTTP calls.
 */
export class AlphaRegistryService {
    constructor(apiUrl) {
        // Default to localhost, or set via env in index.tsx config
        this.apiUrl = 'http://localhost:3000/api';
        if (apiUrl)
            this.apiUrl = apiUrl;
    }
    setApiUrl(url) {
        this.apiUrl = url;
    }
    async getRegistry() {
        try {
            const res = await axios.get(`${this.apiUrl}/registry`);
            return res.data;
        }
        catch (error) {
            console.error('Failed to fetch registry:', error);
            return [];
        }
    }
    async getListerForWallet(walletAddress) {
        try {
            const res = await axios.get(`${this.apiUrl}/registry/${walletAddress}`);
            return res.data.listedBy;
        }
        catch (e) {
            return null;
        }
    }
    async addWallet(targetAddress, finderAddress) {
        try {
            const res = await axios.post(`${this.apiUrl}/registry`, {
                address: targetAddress,
                listedBy: finderAddress
            });
            return { success: true, message: 'Wallet Listed Successfully', profile: res.data.profile };
        }
        catch (error) {
            const msg = error.response?.data?.error || error.message;
            return { success: false, message: msg };
        }
    }
}
export const alphaRegistry = new AlphaRegistryService();
