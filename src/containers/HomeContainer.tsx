import React from 'react';

export const HomeContainer: React.FC = () => {
  return (
    <div id="conversationsView" className="flex flex-col flex-1 overflow-hidden">
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Messages</h2>
      </div>
      <div id="messageList" className="flex-1 overflow-y-auto space-y-1 p-4 pb-28 pt-4">
        <div className="text-center text-zinc-500 py-8">No conversations yet</div>
      </div>
      <div id="inputFooter" className="absolute bottom-0 left-0 right-0 p-4 bg-zinc-50 dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800">
        <input
          type="text"
          placeholder="Message..."
          className="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder-zinc-500"
        />
      </div>
    </div>
  );
};
