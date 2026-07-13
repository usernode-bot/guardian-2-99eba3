export function cleanupLegacyLocalStorage() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('guardian_settings_')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach((key) => {
        localStorage.removeItem(key);
    });
}
//# sourceMappingURL=storage-cleanup.js.map