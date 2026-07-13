import React, { useCallback } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUiStore } from '../../store/ui.store';
import { Header } from './Header';
import { SlideOutMenu } from './SlideOutMenu';
import { ResizableAppContainer } from './ResizableAppContainer';
import { ModalHost } from '../App/ModalHost';
import { ToastContainer } from '../Common/ToastContainer';
import { ConnectionIndicator } from '../Common/ConnectionIndicator';

interface RootLayoutProps {
  isWalletReady: boolean;
  walletAddress?: string;
}

export const RootLayout: React.FC<RootLayoutProps> = ({ isWalletReady, walletAddress }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { setSettingsOpen } = useUiStore();

  const handleCloseWallet = useCallback(() => {
    setSettingsOpen(false);
    navigate('/');
  }, [navigate, setSettingsOpen]);

  const handleMenuClick = useCallback(() => {
    // Menu toggle handled in SlideOutMenu component
  }, []);

  const handleSettingsClick = useCallback(() => {
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  return (
    <>
      <ToastContainer />
      <ModalHost />
      <ResizableAppContainer>
        {!isMobile && (
          <Header
            isWalletReady={isWalletReady}
            walletAddress={walletAddress}
            onCloseWallet={handleCloseWallet}
            onMenuClick={handleMenuClick}
            onSettingsClick={handleSettingsClick}
          />
        )}

        {isMobile && (
          <>
            <div className="absolute top-4 left-1/2 z-50 -translate-x-1/2">
              <ConnectionIndicator />
            </div>
            <SlideOutMenu
              isWalletReady={isWalletReady}
              address={walletAddress}
              onCloseWallet={handleCloseWallet}
            />
          </>
        )}

        <main className="flex-1 overflow-hidden flex flex-col pt-16">
          <Outlet context={{ isWalletReady, walletAddress }} />
        </main>
      </ResizableAppContainer>
    </>
  );
};
