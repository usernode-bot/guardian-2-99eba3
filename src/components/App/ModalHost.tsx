import React from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../store/ui.store';
import { X } from 'lucide-react';

export const ModalHost: React.FC = () => {
  const { shareContactModalOpen, setShareContactModalOpen, postModalOpen, setPostModalOpen } =
    useUiStore();

  return (
    <>
      {shareContactModalOpen &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <div className="bg-white dark:bg-zinc-800 rounded-lg p-6 w-96 max-w-[90vw]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  Share Contact
                </h2>
                <button
                  onClick={() => setShareContactModalOpen(false)}
                  className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  <X size={20} />
                </button>
              </div>
              <p className="text-zinc-600 dark:text-zinc-400">Share contact details...</p>
            </div>
          </div>,
          document.body
        )}

      {postModalOpen &&
        createPortal(
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <div className="bg-white dark:bg-zinc-800 rounded-lg p-6 w-96 max-w-[90vw]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">New Post</h2>
                <button
                  onClick={() => setPostModalOpen(false)}
                  className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  <X size={20} />
                </button>
              </div>
              <p className="text-zinc-600 dark:text-zinc-400">Create a new post...</p>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
