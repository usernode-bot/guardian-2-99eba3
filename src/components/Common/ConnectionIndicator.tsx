import React from 'react';
import { useNetworkStore } from '../../store/network.store';

export const ConnectionIndicator: React.FC = () => {
  const { isConnected, isConnecting } = useNetworkStore();

  const statusColor = isConnecting ? 'bg-yellow-500' : isConnected ? 'bg-green-500' : 'bg-red-500';
  const statusText = isConnecting ? 'Connecting...' : isConnected ? 'Connected' : 'Disconnected';

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${statusColor} transition-colors`} />
      <span className="text-xs text-gray-500">{statusText}</span>
    </div>
  );
};
