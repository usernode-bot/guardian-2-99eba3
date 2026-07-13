import type { NetworkType } from '../types/all';
interface NetworkState {
    network: NetworkType;
    isConnected: boolean;
    isConnecting: boolean;
    setNetwork: (network: NetworkType) => void;
    setConnected: (connected: boolean) => void;
    setConnecting: (connecting: boolean) => void;
}
export declare const useNetworkStore: import("zustand").UseBoundStore<import("zustand").StoreApi<NetworkState>>;
export {};
//# sourceMappingURL=network.store.d.ts.map