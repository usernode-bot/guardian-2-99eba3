import React from 'react';
import { Settings, X } from 'lucide-react';
import { useUiStore } from '../store/ui.store';

export const SettingsContainer: React.FC = () => {
  const { settingsOpen, setSettingsOpen, theme, setTheme } = useUiStore();

  if (!settingsOpen) return null;

  return (
    <div id="settingsPanel" className="fixed left-0 top-0 w-64 h-full bg-zinc-50 dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 z-40 flex flex-col overflow-y-auto">
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings size={20} />
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Settings</h2>
        </div>
        <button
          onClick={() => setSettingsOpen(false)}
          className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 p-4 space-y-4">
        <div id="systemContent" className="space-y-2">
          <h3 className="font-medium text-zinc-900 dark:text-zinc-100">Appearance</h3>
          <div className="space-y-2">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="theme"
                  value={t}
                  checked={theme === t}
                  onChange={() => setTheme(t)}
                  className="cursor-pointer"
                />
                <span className="text-sm text-zinc-700 dark:text-zinc-300 capitalize">{t}</span>
              </label>
            ))}
          </div>
        </div>

        <div id="networkModeContent" className="space-y-2">
          <h3 className="font-medium text-zinc-900 dark:text-zinc-100">Network Mode</h3>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            Coming soon
          </div>
        </div>

        <div id="transactionContent" className="space-y-2">
          <h3 className="font-medium text-zinc-900 dark:text-zinc-100">Transactions</h3>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            Coming soon
          </div>
        </div>

        <div id="configContent" className="space-y-2">
          <h3 className="font-medium text-zinc-900 dark:text-zinc-100">Configuration</h3>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            Coming soon
          </div>
        </div>
      </div>
    </div>
  );
};
