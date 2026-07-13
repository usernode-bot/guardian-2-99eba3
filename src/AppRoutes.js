import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Routes, Route, Navigate } from 'react-router';
import { RootLayout } from './components/Layout/RootLayout';
import { HomeContainer } from './containers/HomeContainer';
import { ContactsContainer } from './containers/ContactsContainer';
import { ProfileContainer } from './containers/ProfileContainer';
export const AppRoutes = ({ isWalletReady, walletAddress, }) => {
    return (_jsx(Routes, { children: _jsxs(Route, { element: _jsx(RootLayout, { isWalletReady: isWalletReady, walletAddress: walletAddress }), children: [_jsx(Route, { index: true, element: _jsx(HomeContainer, {}) }), _jsx(Route, { path: "contacts", element: _jsx(ContactsContainer, {}) }), _jsx(Route, { path: "profile", element: _jsx(ProfileContainer, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }) }));
};
//# sourceMappingURL=AppRoutes.js.map