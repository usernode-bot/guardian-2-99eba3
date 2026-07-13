import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

interface UIState {
  theme: Theme;
  settingsOpen: boolean;
  shareContactModalOpen: boolean;
  postModalOpen: boolean;
  customColors?: Record<string, string>;
  getEffectiveTheme: () => 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  setSettingsOpen: (open: boolean) => void;
  setShareContactModalOpen: (open: boolean) => void;
  setPostModalOpen: (open: boolean) => void;
  setCustomColors: (colors: Record<string, string>) => void;
}

export const useUiStore = create<UIState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      settingsOpen: false,
      shareContactModalOpen: false,
      postModalOpen: false,
      customColors: undefined,

      getEffectiveTheme: () => {
        const theme = get().theme;
        if (theme === 'system') {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        return theme;
      },

      setTheme: (theme: Theme) => set({ theme }),
      setSettingsOpen: (open: boolean) => set({ settingsOpen: open }),
      setShareContactModalOpen: (open: boolean) => set({ shareContactModalOpen: open }),
      setPostModalOpen: (open: boolean) => set({ postModalOpen: open }),
      setCustomColors: (colors: Record<string, string>) => set({ customColors: colors }),
    }),
    {
      name: 'guardian_ui_store',
      version: 1,
    }
  )
);
