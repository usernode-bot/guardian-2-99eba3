# guardian-2-99eba3
Guardian 2 — built on Usernode Social Vibecoding

## Real-time Wallet Address Search

Wallet addresses are synced from the Usernode registry at startup and periodically refreshed to enable real-time search results. Users can search for contacts by their wallet addresses (e.g., `ut1staging-alice-001`) immediately after their address is registered in the system.

### Configuration

Two optional environment variables control user sync behavior:

- **`USERNODE_USER_REGISTRY_URL`** (optional): URL to the Usernode user registry API endpoint. If not set:
  - In **staging**: users are loaded from the local `staging-users.json` file
  - In **production**: user sync is skipped (relies on auth-time upserts only)
  - Example: `https://usernode.example.com/api/users`

- **`USERNODE_SYNC_INTERVAL_MS`** (optional, default: `600000`): Interval in milliseconds between periodic syncs (default 10 minutes). Only active when `USERNODE_USER_REGISTRY_URL` is set or in staging mode.

### How it works

1. On startup, `fetchUsersFromUsernode()` is called to populate the `users` table with wallet addresses
2. A periodic interval then keeps user data fresh by re-syncing every 10 minutes (configurable)
3. The `/api/search/users` endpoint queries these pre-populated wallet addresses in real-time
4. In staging, mock user data is loaded from `staging-users.json` for testing without a real registry API
