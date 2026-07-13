import { create } from 'zustand';
import type { NetworkType } from '../types/all';

interface NetworkState {
  network: NetworkType;
  isConnected: boolean;
  isConnecting: boolean;
  setNetwork: (network: NetworkType) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  network: 'devnet',
  isConnected: false,
  isConnecting: false,

  setNetwork: (network: NetworkType) => set({ network }),
  setConnected: (connected: boolean) => set({ isConnected: connected }),
  setConnecting: (connecting: boolean) => set({ isConnecting: connecting }),
}));
