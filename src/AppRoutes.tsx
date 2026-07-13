import React from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { RootLayout } from './components/Layout/RootLayout';
import { HomeContainer } from './containers/HomeContainer';
import { ContactsContainer } from './containers/ContactsContainer';
import { ProfileContainer } from './containers/ProfileContainer';
import type { NetworkType } from './types/all';

interface AppRoutesProps {
  isWalletReady: boolean;
  walletAddress?: string;
  network: NetworkType;
  isConnected: boolean;
  isConnecting: boolean;
  onNetworkChange: (n: NetworkType) => void;
}

export const AppRoutes: React.FC<AppRoutesProps> = ({
  isWalletReady,
  walletAddress,
}) => {
  return (
    <Routes>
      <Route element={<RootLayout isWalletReady={isWalletReady} walletAddress={walletAddress} />}>
        <Route index element={<HomeContainer />} />
        <Route path="contacts" element={<ContactsContainer />} />
        <Route path="profile" element={<ProfileContainer />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
};
