export function syncThemeColorMeta(theme = 'dark') {
    const metaTag = document.querySelector('meta[name="theme-color"]');
    if (!metaTag)
        return;
    const color = theme === 'dark' ? '#242424' : '#f2f2f2';
    metaTag.setAttribute('content', color);
}
//# sourceMappingURL=meta-theme-syncer.js.map