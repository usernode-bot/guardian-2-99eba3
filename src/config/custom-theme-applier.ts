export function applyCustomColors(colors: Record<string, string>): void {
  const root = document.documentElement;
  Object.entries(colors).forEach(([key, value]) => {
    root.style.setProperty(`--${key}`, value);
  });
}

export function resetCustomColors(): void {
  const root = document.documentElement;
  const customColorKeys = [
    'primary-bg',
    'secondary-bg',
    'primary-border',
    'secondary-border',
    'text-primary',
    'text-secondary',
    'accent-blue',
    'accent-cyan',
    'accent-purple',
    'accent-green',
    'accent-yellow',
    'accent-orange',
    'accent-red',
    'input-bg',
    'success',
    'button-primary',
    'text-warning',
  ];

  customColorKeys.forEach((key) => {
    root.style.removeProperty(`--${key}`);
  });
}
