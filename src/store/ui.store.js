import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const useUiStore = create()(persist((set, get) => ({
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
    setTheme: (theme) => set({ theme }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setShareContactModalOpen: (open) => set({ shareContactModalOpen: open }),
    setPostModalOpen: (open) => set({ postModalOpen: open }),
    setCustomColors: (colors) => set({ customColors: colors }),
}), {
    name: 'guardian_ui_store',
    version: 1,
}));
//# sourceMappingURL=ui.store.js.map