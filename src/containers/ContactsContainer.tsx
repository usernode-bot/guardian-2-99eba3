import React from 'react';
import { Users } from 'lucide-react';

export const ContactsContainer: React.FC = () => {
  return (
    <div id="contactsView" className="flex flex-col flex-1 overflow-hidden">
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <Users size={20} className="text-zinc-600 dark:text-zinc-400" />
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Contacts</h2>
        </div>
      </div>
      <div id="contactsList" className="flex-1 overflow-y-auto p-4">
        <div className="text-center text-zinc-500 py-8">No contacts yet</div>
      </div>
    </div>
  );
};
