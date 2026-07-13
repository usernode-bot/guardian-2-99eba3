import type { NetworkType } from '../types/all';
interface OrchestratorHook {
    connect: (options?: {
        networkType?: NetworkType;
    }) => Promise<void>;
    onPause: () => void;
    onResume: () => void;
}
export declare function useOrchestrator(): OrchestratorHook;
export {};
//# sourceMappingURL=useOrchestrator.d.ts.map