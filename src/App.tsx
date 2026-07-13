import React, { useCallback, useEffect } from 'react';
import { BrowserRouter } from 'react-router';
import { useNetworkStore } from './store/network.store';
import { useUiStore } from './store/ui.store';
import { useIsMobile } from './hooks/useIsMobile';
import { useOrchestrator } from './hooks/useOrchestrator';
import { syncThemeColorMeta } from './utils/meta-theme-syncer';
import { applyCustomColors, resetCustomColors } from './config/custom-theme-applier';
import { cleanupLegacyLocalStorage } from './utils/storage-cleanup';
import { AppRoutes } from './AppRoutes';
import type { NetworkType } from './types/all';

const App: React.FC = () => {
  const networkStore = useNetworkStore();
  const { theme, getEffectiveTheme, customColors } = useUiStore();
  const { connect } = useOrchestrator();
  const isMobile = useIsMobile();

  useEffect(() => {
    const asyncDefer = async () => {
      await connect();
      cleanupLegacyLocalStorage();
    };
    asyncDefer();
  }, [connect]);

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    meta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
  }, [isMobile]);

  useEffect(() => {
    const effectiveTheme = getEffectiveTheme();
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    syncThemeColorMeta(effectiveTheme);

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleSystemThemeChange = () => {
      if (theme === 'system') {
        const newEffectiveTheme = getEffectiveTheme();
        document.documentElement.setAttribute('data-theme', newEffectiveTheme);
        syncThemeColorMeta(newEffectiveTheme);
      }
    };

    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => {
      mediaQuery.removeEventListener('change', handleSystemThemeChange);
    };
  }, [theme, getEffectiveTheme]);

  useEffect(() => {
    if (customColors) {
      applyCustomColors(customColors);
    } else {
      resetCustomColors();
    }
  }, [theme, customColors]);

  const onNetworkChange = useCallback(
    (n: NetworkType) => {
      networkStore.setNetwork(n);
      connect({ networkType: n });
    },
    [connect, networkStore]
  );

  return (
    <BrowserRouter>
      <AppRoutes
        isWalletReady={false}
        walletAddress={undefined}
        network={networkStore.network}
        isConnected={networkStore.isConnected}
        isConnecting={networkStore.isConnecting}
        onNetworkChange={onNetworkChange}
      />
    </BrowserRouter>
  );
};

export default App;
