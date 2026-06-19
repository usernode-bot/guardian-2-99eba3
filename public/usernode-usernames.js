// Vendored from usernode-dapp-starter
// UsernodeUsernames: client-side username resolution system

(function() {
  'use strict';

  class UsernodeUsernames {
    constructor() {
      this.cache = new Map();
      this.isInitialized = false;
    }

    async initialize() {
      if (this.isInitialized) return;
      try {
        const response = await fetch('/__usernames/state');
        if (response.ok) {
          const usernames = await response.json();
          Object.entries(usernames).forEach(([pubkey, username]) => {
            this.cache.set(pubkey, username);
          });
        }
      } catch (e) {
        console.warn('Failed to initialize UsernodeUsernames:', e);
      }
      this.isInitialized = true;
    }

    async getUsername(pubkey) {
      if (!pubkey) return null;

      // Check cache first
      if (this.cache.has(pubkey)) {
        return this.cache.get(pubkey);
      }

      // Try to fetch from API
      try {
        const response = await fetch(`/api/usernames/${encodeURIComponent(pubkey)}`);
        if (response.ok) {
          const data = await response.json();
          if (data.username) {
            this.cache.set(pubkey, data.username);
            return data.username;
          }
        }
      } catch (e) {
        console.warn(`Failed to fetch username for ${pubkey}:`, e);
      }

      return null;
    }

    setUsername(pubkey, username) {
      if (pubkey && username) {
        this.cache.set(pubkey, username);
      }
    }

    importLegacyUsernames(usernamesMap) {
      if (!usernamesMap || typeof usernamesMap !== 'object') return;
      Object.entries(usernamesMap).forEach(([pubkey, username]) => {
        if (pubkey && username) {
          this.cache.set(pubkey, username);
        }
      });
    }
  }

  // Create global singleton instance
  window.UsernodeUsernames = new UsernodeUsernames();
})();
