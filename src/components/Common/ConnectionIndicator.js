import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useNetworkStore } from '../../store/network.store';
export const ConnectionIndicator = () => {
    const { isConnected, isConnecting } = useNetworkStore();
    const statusColor = isConnecting ? 'bg-yellow-500' : isConnected ? 'bg-green-500' : 'bg-red-500';
    const statusText = isConnecting ? 'Connecting...' : isConnected ? 'Connected' : 'Disconnected';
    return (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: `w-2 h-2 rounded-full ${statusColor} transition-colors` }), _jsx("span", { className: "text-xs text-gray-500", children: statusText })] }));
};
//# sourceMappingURL=ConnectionIndicator.js.map