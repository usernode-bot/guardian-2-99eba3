import { create } from 'zustand';
export const useNetworkStore = create((set) => ({
    network: 'devnet',
    isConnected: false,
    isConnecting: false,
    setNetwork: (network) => set({ network }),
    setConnected: (connected) => set({ isConnected: connected }),
    setConnecting: (connecting) => set({ isConnecting: connecting }),
}));
//# sourceMappingURL=network.store.js.map