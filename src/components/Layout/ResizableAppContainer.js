import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect } from 'react';
export const ResizableAppContainer = ({ children }) => {
    useEffect(() => {
        const meta = document.querySelector('meta[name="viewport"]');
        if (!meta)
            return;
        meta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    }, []);
    return (_jsx("div", { className: "w-screen h-screen overflow-hidden flex flex-col", children: children }));
};
//# sourceMappingURL=ResizableAppContainer.js.map