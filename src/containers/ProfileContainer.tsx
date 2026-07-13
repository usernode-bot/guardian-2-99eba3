import React from 'react';
import { User } from 'lucide-react';

export const ProfileContainer: React.FC = () => {
  return (
    <div id="profileView" className="flex flex-col flex-1 overflow-hidden">
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <User size={20} className="text-zinc-600 dark:text-zinc-400" />
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Profile</h2>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="text-center text-zinc-500 py-8">Profile information</div>
      </div>
    </div>
  );
};
