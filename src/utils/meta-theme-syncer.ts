export function syncThemeColorMeta(theme: 'light' | 'dark' = 'dark'): void {
  const metaTag = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]'
  );
  if (!metaTag) return;

  const color = theme === 'dark' ? '#242424' : '#f2f2f2';
  metaTag.setAttribute('content', color);
}
