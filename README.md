# guardian-2-99eba3
Guardian 2 — built on Usernode Social Vibecoding

## Real-time Wallet Address Search

Wallet addresses are synced from the Usernode registry at startup and periodically refreshed to enable real-time search results. Users can search for contacts by their wallet addresses (e.g., `ut1staging-alice-001`) immediately after their address is registered in the system.

### Configuration

Two optional environment variables control user sync behavior:

- **`USERNODE_USER_REGISTRY_URL`** (optional): URL to the Usernode user registry API endpoint. When set, the app attempts to fetch real user data from this endpoint. If the API call fails or times out, the app falls back to mock data in staging. If not set:
  - In **staging**: mock user data is loaded from the local `staging-users.json` file
  - In **production**: user sync is skipped (relies on auth-time upserts only)
  - Example: `https://usernode.example.com/api/users`

- **`USERNODE_SYNC_INTERVAL_MS`** (optional, default: `600000`): Interval in milliseconds between periodic syncs (default 10 minutes). Only active when `USERNODE_USER_REGISTRY_URL` is set or in staging mode.

### How it works

1. On startup, `fetchUsersFromUsernode()` is called to populate the `users` table with wallet addresses:
   - **Attempts real data first**: If `USERNODE_USER_REGISTRY_URL` is set, tries to fetch from the real registry API
   - **Falls back to mock on failure**: If the API call fails or returns no data, falls back to `staging-users.json` in staging
   - **Explicit logging**: Console logs indicate whether real or mock data was used ("Fetched from real registry API" vs. "Using mock staging users")
2. A periodic interval then keeps user data fresh by re-syncing every 10 minutes (configurable)
3. The `/api/search/users` endpoint queries these pre-populated wallet addresses in real-time
4. Mock user data from `staging-users.json` is only used when real data is unavailable (API misconfigured, timeout, or empty response)
