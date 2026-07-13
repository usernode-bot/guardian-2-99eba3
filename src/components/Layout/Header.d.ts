import React from 'react';
interface HeaderProps {
    isWalletReady: boolean;
    walletAddress?: string;
    onCloseWallet: () => void;
    onMenuClick: () => void;
    onSettingsClick: () => void;
}
export declare const Header: React.FC<HeaderProps>;
export {};
//# sourceMappingURL=Header.d.ts.map