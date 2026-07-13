import React from 'react';
import { Menu, Settings } from 'lucide-react';

interface HeaderProps {
  isWalletReady: boolean;
  walletAddress?: string;
  onCloseWallet: () => void;
  onMenuClick: () => void;
  onSettingsClick: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  isWalletReady,
  walletAddress,
  onMenuClick,
  onSettingsClick,
}) => {
  return (
    <header className="bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-300 dark:border-zinc-800 px-4 py-3 flex items-center gap-3 fixed top-0 left-0 right-0 z-40 w-full h-16">
      <button
        onClick={onMenuClick}
        className="text-cyan-600 dark:text-cyan-400 hover:text-cyan-700 dark:hover:text-cyan-300 transition p-2"
        title="Toggle sidebar"
      >
        <Menu size={20} />
      </button>

      <div className="flex-1 flex flex-col items-start">
        <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Guardian</div>
        {isWalletReady && walletAddress && (
          <div className="text-xs text-zinc-600 dark:text-zinc-500 truncate">{walletAddress}</div>
        )}
      </div>

      <button
        onClick={onSettingsClick}
        className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-300 transition p-2"
        title="Settings"
      >
        <Settings size={20} />
      </button>
    </header>
  );
};
