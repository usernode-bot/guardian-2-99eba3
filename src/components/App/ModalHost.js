import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { createPortal } from 'react-dom';
import { useUiStore } from '../../store/ui.store';
import { X } from 'lucide-react';
export const ModalHost = () => {
    const { shareContactModalOpen, setShareContactModalOpen, postModalOpen, setPostModalOpen } = useUiStore();
    return (_jsxs(_Fragment, { children: [shareContactModalOpen &&
                createPortal(_jsx("div", { className: "fixed inset-0 bg-black/50 z-50 flex items-center justify-center", children: _jsxs("div", { className: "bg-white dark:bg-zinc-800 rounded-lg p-6 w-96 max-w-[90vw]", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h2", { className: "text-lg font-semibold text-zinc-900 dark:text-zinc-100", children: "Share Contact" }), _jsx("button", { onClick: () => setShareContactModalOpen(false), className: "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300", children: _jsx(X, { size: 20 }) })] }), _jsx("p", { className: "text-zinc-600 dark:text-zinc-400", children: "Share contact details..." })] }) }), document.body), postModalOpen &&
                createPortal(_jsx("div", { className: "fixed inset-0 bg-black/50 z-50 flex items-center justify-center", children: _jsxs("div", { className: "bg-white dark:bg-zinc-800 rounded-lg p-6 w-96 max-w-[90vw]", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h2", { className: "text-lg font-semibold text-zinc-900 dark:text-zinc-100", children: "New Post" }), _jsx("button", { onClick: () => setPostModalOpen(false), className: "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300", children: _jsx(X, { size: 20 }) })] }), _jsx("p", { className: "text-zinc-600 dark:text-zinc-400", children: "Create a new post..." })] }) }), document.body)] }));
};
//# sourceMappingURL=ModalHost.js.map