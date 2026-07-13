import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUiStore } from '../../store/ui.store';
import { Header } from './Header';
import { SlideOutMenu } from './SlideOutMenu';
import { ResizableAppContainer } from './ResizableAppContainer';
import { ModalHost } from '../App/ModalHost';
import { ToastContainer } from '../Common/ToastContainer';
import { ConnectionIndicator } from '../Common/ConnectionIndicator';
export const RootLayout = ({ isWalletReady, walletAddress }) => {
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
    return (_jsxs(_Fragment, { children: [_jsx(ToastContainer, {}), _jsx(ModalHost, {}), _jsxs(ResizableAppContainer, { children: [!isMobile && (_jsx(Header, { isWalletReady: isWalletReady, walletAddress: walletAddress, onCloseWallet: handleCloseWallet, onMenuClick: handleMenuClick, onSettingsClick: handleSettingsClick })), isMobile && (_jsxs(_Fragment, { children: [_jsx("div", { className: "absolute top-4 left-1/2 z-50 -translate-x-1/2", children: _jsx(ConnectionIndicator, {}) }), _jsx(SlideOutMenu, { isWalletReady: isWalletReady, address: walletAddress, onCloseWallet: handleCloseWallet })] })), _jsx("main", { className: "flex-1 overflow-hidden flex flex-col pt-16", children: _jsx(Outlet, { context: { isWalletReady, walletAddress } }) })] })] }));
};
//# sourceMappingURL=RootLayout.js.map