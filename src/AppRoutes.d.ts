import React from 'react';
import type { NetworkType } from './types/all';
interface AppRoutesProps {
    isWalletReady: boolean;
    walletAddress?: string;
    network: NetworkType;
    isConnected: boolean;
    isConnecting: boolean;
    onNetworkChange: (n: NetworkType) => void;
}
export declare const AppRoutes: React.FC<AppRoutesProps>;
export {};
//# sourceMappingURL=AppRoutes.d.ts.map