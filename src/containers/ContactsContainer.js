import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Users } from 'lucide-react';
export const ContactsContainer = () => {
    return (_jsxs("div", { id: "contactsView", className: "flex flex-col flex-1 overflow-hidden", children: [_jsx("div", { className: "p-4 border-b border-zinc-200 dark:border-zinc-800", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Users, { size: 20, className: "text-zinc-600 dark:text-zinc-400" }), _jsx("h2", { className: "text-lg font-semibold text-zinc-900 dark:text-zinc-100", children: "Contacts" })] }) }), _jsx("div", { id: "contactsList", className: "flex-1 overflow-y-auto p-4", children: _jsx("div", { className: "text-center text-zinc-500 py-8", children: "No contacts yet" }) })] }));
};
//# sourceMappingURL=ContactsContainer.js.map