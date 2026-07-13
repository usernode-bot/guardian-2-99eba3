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
export declare const useUiStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<UIState>, "setState" | "persist"> & {
    setState(partial: UIState | Partial<UIState> | ((state: UIState) => UIState | Partial<UIState>), replace?: false | undefined): unknown;
    setState(state: UIState | ((state: UIState) => UIState), replace: true): unknown;
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<UIState, UIState, unknown>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: UIState) => void) => () => void;
        onFinishHydration: (fn: (state: UIState) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<UIState, UIState, unknown>>;
    };
}>;
export {};
//# sourceMappingURL=ui.store.d.ts.map