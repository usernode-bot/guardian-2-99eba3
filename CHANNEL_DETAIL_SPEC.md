# Channel Detail View Implementation Specification

## Overview
The channel detail view allows users to see posts within a specific channel and (if they're the owner or following) submit new posts. The system is fully implemented and functional with proper validation, error handling, and UI state management.

## Architecture

### DOM Structure
The channel detail view consists of three main container groups:

1. **Channel Chat View Container** (`id="channelChatView"`)
   - Main flex container (hidden by default, shown when user clicks a channel)
   - Contains the scrollable post list
   - Classes: `hidden flex flex-col flex-1 overflow-hidden`
   - Visibility controlled by `showChannelChatView()` function
   - Direct child: `channelChatList` (the scrollable area)

2. **Channel Chat List** (`id="channelChatList"`)
   - Scrollable container within `channelChatView`
   - Renders:
     - Compose box (sticky, top of view) - shown for owner or followers
     - Post list (dynamic, rendered from API response)
     - Empty state message (if no posts exist)
     - Load more button (pagination, if `hasMore: true`)
   - Classes: Flex column with overflow-y-auto for scrolling
   - Scroll position reset to 0 on new channel load (CRITICAL BUG FIX #3)

3. **Legacy Header Container** (`id="channelDetailHeader"`)
   - Deprecated custom header (kept for backwards compatibility, hidden in current code)
   - Hidden when channel detail view shows (replaced by standard header pattern)

### Data Flow

```
User clicks channel card
    ↓
showChannelPosts(channelId) called with string ID from onclick
    ↓
Parse & validate ID: parseInt(channelId, 10) with NaN check
    ↓
Load channel from channelsList (loaded during app init)
    ↓
If not found locally, call loadChannels() to refresh
    ↓
Set global state: currentChannelId, currentChannel
    ↓
Update header: "Channel" branding + channel name/description
    ↓
Set up action buttons:
  - Owner: "Settings" button
  - Non-owner: "Follow"/"Following" button
    ↓
Call showChannelChatView() to show/hide containers
    ↓
Call loadChannelPosts(channelId) to fetch posts
    ↓
Set up polling: setInterval(loadChannelPosts, 2000)
```

### Component Functions

#### `showChannelPosts(channelId)` (Line 6944)
**Purpose**: Main entry point when user clicks a channel card

**Validation:**
- Parse channelId: `parseInt(channelId, 10)` with radix parameter
- Check for NaN: `if (isNaN(parsedChannelId))`
- Verify channel exists in `channelsList`
- Reload channels if not found (handles newly created channels)
- Verify all required DOM elements exist

**State Updates:**
- Clear cross-context state: `currentConvId`, `currentOtherId`, `currentGroupId` set to null
- Set: `currentChannelId`, `currentChannel`
- Reset pagination: `channelPostsOffset = 0`, `channelPostsHasMore = false`

**UI Updates:**
- Show standard header (matching DM/Group pattern)
- Hide old custom header (`channelDetailHeader`)
- Clear compose box from previous channel
- Set up action buttons based on ownership/following status
- Call `showChannelChatView()` to hide other views and show channel view

**Polling:**
- Clear existing poll interval
- Start new 2-second poll for fresh posts: `setInterval(() => loadChannelPosts(parsedChannelId), 2000)`
- Uses parsed numeric ID to avoid stale closure bugs (CRITICAL BUG FIX #4)

#### `loadChannelPosts(channelId)` (Line 7060)
**Purpose**: Fetch and render channel posts

**Process:**
1. Parse channelId to numeric
2. Guard: return if `currentChannelId` doesn't match (prevents rendering stale posts)
3. API call: `GET /api/channels/{channelId}/posts?limit=50&offset=0`
4. Build HTML dynamically:
   - Compose box (sticky, top-0, z-[99]) if owner OR following
   - Empty state if no posts
   - Post list if posts exist
   - Load more button if `hasMore: true`
5. Render into `channelChatList` container
6. Reset scroll position to top (line 7140)

**Compose Box Details** (lines 7087-7115):
- TextArea: `id="channelPostInput"`, placeholder: "Write a post in #channelName..."
- Max length: 2000 characters
- Image preview: `id="channelPostImagePreview"` (flex wrap for multi-image)
- Char count: `id="channelPostCharCount"`, format: "0/2000"
- Buttons:
  - Image attach: `onclick="attachImageToChannelPost()"`
  - Post button: `id="channelPostBtn"`, `onclick="submitChannelPost()"`
  - Post button disabled until text OR images exist

**Error Handling:**
- Validate `channelsList` exists and is array (CRITICAL BUG FIX #10)
- Catch and log API errors
- Show toast notifications on failure

#### `submitChannelPost()` (Line 7262)
**Purpose**: Submit a new post to the channel

**Validation:**
- Check for text content OR images
- Enforce 2000 char limit
- Show error if empty or over limit

**Process:**
1. Disable post button (show loading state)
2. API call: `POST /api/channels/{currentChannelId}/posts`
3. Body: `{ content: text, imageUrls: channelPostImages }`
4. On success:
   - Clear textarea and image array
   - Update char count display
   - Show success toast
   - Call `loadChannelPostsAfterSubmit()` to refresh and reset compose box
5. On error: show error toast

**Button State:**
- Disabled by default
- Enabled when: text length > 0 OR channelPostImages.length > 0
- AND text length ≤ 2000
- Update triggered on textarea input: `oninput="updateChannelPostCharCount()"`

#### `updateChannelPostCharCount()` (Line 7245)
**Purpose**: Update character count display and button state

**Updates:**
- Count display: format as "X/2000"
- Button disabled state: `!hasContent || count > 2000`
- hasContent = `count > 0 || channelPostImages.length > 0`

#### `loadMoreChannelPosts(channelId)` (Line 7154)
**Purpose**: Pagination - load older posts

**Process:**
1. Guard: return if already loading or no more posts
2. API call: `GET /api/channels/{channelId}/posts?limit=50&offset={channelPostsOffset}`
3. Insert new posts before the "Load more" button
4. Update offset: `channelPostsOffset += 50`
5. Update button visibility based on `hasMore`

#### `backToChannelList()` (Line 7547)
**Purpose**: Return to channel feed view

**State Reset Order:**
1. Clear polling interval FIRST (MEDIUM BUG FIX #6)
2. Reset global state: `currentChannelId`, `currentChannel`, pagination
3. Call `showFeedView()` to hide channel view and show feed

#### `showChannelChatView()` (Line 6781)
**Purpose**: Hide other views and show the channel chat view

**Hide:**
- messagesView, conversationsView, chatView, profileView, contactsView, feedView

**Show:**
- channelChatView (add `active-channel` class)

**Side Effects:**
- Hide inputFooter
- Add `header-chat-fixed` class to header
- Clear conversationsPollInterval

#### `renderChannelPost(post)` (Line 7198)
**Purpose**: Generate HTML for a single post

**Data Points:**
- User: `post.userId` (anonymized in API response as "Anonymous")
- Content: `post.content.text`
- Timestamp: `post.createdAt` (formatted as relative time)
- Edit status: `post.isEdited`, `post.updatedAt`
- Images: `post.imageUrls` array

**Ownership Logic:**
- Owner if: `currentUser.id === post.userId` OR `currentUser.id === currentChannel.ownerId`
- Owner actions: edit, delete (action menu available for owners)

## Global State Variables

```javascript
currentChannelId        // numeric ID of currently viewed channel
currentChannel          // object with: id, name, description, ownerId, isFollowing
channelPostsOffset      // pagination offset (incremented by 50 for each load more)
channelPostsHasMore     // boolean, true if more posts exist on server
channelPostImages       // array of image URLs for compose
pollInterval            // setInterval ID for 2-second post poll
isLoadingChannelPosts   // flag to prevent concurrent loads
```

## API Endpoints Used

1. **GET /api/channels** (Line 5539)
   - Returns: `{ channels: [{ id, name, description, ownerId, isFollowing, ownerUsername, ... }] }`
   - Note: ownerUsername will be "Anonymous" in response (anonymized)

2. **GET /api/channels/:channelId/posts** (Line 5570)
   - Query: `?limit=50&offset=0`
   - Returns: `{ posts: [...], hasMore: boolean }`
   - Each post has: `{ id, userId, content: { text }, createdAt, updatedAt, isEdited, imageUrls }`
   - Note: userId in response will show "Anonymous" (anonymized)

3. **POST /api/channels/:channelId/posts** (Line 5656)
   - Body: `{ content: string, imageUrls: [...] }`
   - Creates new post in channel

4. **PUT /api/channels/:channelId** (Line 5693)
   - Body: `{ name, description }`
   - Updates channel settings (owner only)

5. **DELETE /api/channels/:channelId** (Line 5721)
   - Deletes channel (owner only)

## UI/UX Flow

### View Transitions

**Channel List (Feed) → Channel Detail:**
1. User sees list of channels in feed view
2. Clicks channel card: `onclick="showChannelPosts(${channel.id})"`
3. View transitions: feed hidden, channel detail shown
4. Header changes to show channel name and description
5. Action button appears (Settings or Follow)
6. Compose box shown (if owner/following)
7. Posts load and display
8. 2-second poll starts

**Channel Detail → Channel List (Feed):**
1. User clicks back button (header) or navigates away
2. `backToChannelList()` called
3. Polling stopped
4. Global state cleared
5. View transitions: channel detail hidden, feed shown
6. Header reverts to channel list view

### Compose Box Behavior

- **Visibility**: Shown only for channel owner or followers
- **Position**: Sticky to top (z-[99], top-0) so always visible while scrolling
- **Input**: TextArea, 3 rows, up to 2000 chars
- **Images**: Optional, shown in preview strip below textarea
- **Submit**: Post button enabled when text > 0 OR images exist, and text ≤ 2000 chars

### Post Rendering

- **List**: Space-y-3 (gap between posts)
- **Timestamps**: Relative time format ("2 hours ago")
- **User**: "Anonymous" (anonymized)
- **Content**: Text + optional images
- **Actions**: Edit/Delete menu for post owner or channel owner
- **Editing**: Posts marked with edit timestamp if modified

### Pagination

- **Initial Load**: 50 posts
- **Load More**: Button appears if server indicates more posts available
- **Offset**: Incremented by 50 for each load more click
- **Updates**: New posts loaded without losing scroll context (inserts before button)

## CSS Classes Used

- `hidden`: display: none (show/hide views)
- `flex flex-col flex-1`: flexbox layout
- `overflow-hidden`: prevent scroll on container
- `sticky top-0 z-[99]`: sticky compose box at top
- `active-channel`: applied to channelChatView when active
- `header-chat-fixed`: applied to header in channel view
- `active-chat`: applied to chatView in DM/Group views (removed in channel)
- `space-y-3`: vertical spacing between posts
- `flex flex-wrap gap-2`: image preview grid

## Known Limitations & Considerations

1. **No real-time update indicators**: Polling every 2 seconds, not true real-time. New posts appear after slight delay.

2. **Compose box regenerated on post submit**: `loadChannelPostsAfterSubmit()` rebuilds entire post list and compose box. Prevents duplication but adds latency.

3. **No draft saving**: Compose text cleared on submit, no recovery if connection fails mid-submit.

4. **No infinite scroll**: Uses "Load more" button, not automatic scroll-to-load.

5. **Single channel viewing**: Can only view one channel at a time. Opening another channel replaces current view.

6. **All usernames anonymized**: No way to distinguish between different users posting in a channel (all show "Anonymous").

## Implementation Quality

### Strengths
✓ Comprehensive validation at multiple layers (parse, NaN check, DOM existence)
✓ Proper state management with cross-context isolation
✓ Polling pattern matches DM/Group conventions
✓ Error handling with user feedback (toast notifications)
✓ Responsive button states tied to content validation
✓ Scroll position reset on channel change
✓ Clean separation between view show/hide logic

### Areas Already Fixed
✓ CRITICAL BUG FIX #3: Scroll position reset to 0 on new channel
✓ CRITICAL BUG FIX #4: Numeric ID captured in closure instead of string
✓ CRITICAL BUG FIX #10: Validation of channelsList before use
✓ MEDIUM BUG FIX #6: Poll cleared before state reset in backToChannelList
✓ parseInt radix parameter and NaN validation (initial 404 fix)
✓ Username anonymization across all API responses

## Conclusion

The channel detail view is **fully implemented and functional**. All required components exist:
- ✓ Container structure for displaying channel posts
- ✓ JavaScript functions for showing/hiding views
- ✓ Data flow from click → API → render
- ✓ Form elements for posting (textarea, image attachment, char count, submit)
- ✓ Pagination and polling for fresh content
- ✓ State management and error handling

No structural changes are needed. The system handles:
- Channel selection and detail display
- Post submission and formatting
- Image attachment and preview
- Ownership-based UI customization
- Polling and pagination
- Proper cleanup on navigation

The implementation follows the existing DM/Group chat patterns and maintains consistency with the overall application architecture.
