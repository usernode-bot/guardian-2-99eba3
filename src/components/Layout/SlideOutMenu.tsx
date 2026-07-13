import React, { useState } from 'react';
import { X, MessageSquare, Users, User, Settings, LogOut } from 'lucide-react';

interface SlideOutMenuProps {
  isWalletReady: boolean;
  address?: string;
  onCloseWallet: () => void;
}

export const SlideOutMenu: React.FC<SlideOutMenuProps> = ({
  isWalletReady,
  address,
  onCloseWallet,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const toggleMenu = () => setIsOpen(!isOpen);

  return (
    <>
      <button
        onClick={toggleMenu}
        className="fixed top-4 left-4 z-50 bg-cyan-600 dark:bg-cyan-400 text-white dark:text-zinc-900 rounded-lg p-2 lg:hidden"
      >
        <MessageSquare size={20} />
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      <aside
        className={`fixed left-0 top-0 h-full w-64 bg-zinc-50 dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 z-40 flex flex-col overflow-y-auto transform transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:static lg:translate-x-0`}
      >
        <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Guardian</h2>
          <button
            onClick={() => setIsOpen(false)}
            className="lg:hidden text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <button className="w-full text-left px-4 py-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition text-cyan-600 dark:text-cyan-400 flex items-center gap-2">
            <MessageSquare size={16} />
            Messages
          </button>
          <button className="w-full text-left px-4 py-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition text-zinc-700 dark:text-zinc-400 flex items-center gap-2">
            <Users size={16} />
            Contacts
          </button>
          <button className="w-full text-left px-4 py-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition text-zinc-700 dark:text-zinc-400 flex items-center gap-2">
            <User size={16} />
            Profile
          </button>
        </nav>

        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
          <button className="w-full text-left px-4 py-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition text-zinc-700 dark:text-zinc-400 flex items-center gap-2">
            <Settings size={16} />
            Settings
          </button>
          {isWalletReady && (
            <button
              onClick={onCloseWallet}
              className="w-full text-left px-4 py-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition text-red-600 dark:text-red-400 flex items-center gap-2"
            >
              <LogOut size={16} />
              Lock Wallet
            </button>
          )}
        </div>

        {isWalletReady && address && (
          <div className="p-4 border-t border-zinc-200 dark:border-zinc-800">
            <div className="text-xs text-zinc-600 dark:text-zinc-500 break-all">{address}</div>
          </div>
        )}
      </aside>
    </>
  );
};
