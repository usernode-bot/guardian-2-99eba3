// Mock data generator for demo mode
// Provides deterministic, realistic mock data for all API endpoints

const MOCK_USERS = [
  { id: 1, username: 'alice', usernode_pubkey: 'ut1alice123', verified_at: '2024-01-15T10:00:00Z', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alice', bio: 'Guardian enthusiast' },
  { id: 2, username: 'bob', usernode_pubkey: 'ut1bob456', verified_at: null, avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=bob', bio: 'Explorer' },
  { id: 3, username: 'charlie', usernode_pubkey: 'ut1charlie789', verified_at: '2024-02-20T14:30:00Z', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=charlie', bio: 'Developer & tester' },
  { id: 4, username: 'diana', usernode_pubkey: 'ut1diana101', verified_at: '2024-03-10T09:15:00Z', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=diana', bio: 'Content creator' },
  { id: 5, username: 'eve', usernode_pubkey: null, verified_at: null, avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=eve', bio: 'New member' },
];

function getTimeOffset(minutesAgo) {
  const now = new Date();
  return new Date(now.getTime() - minutesAgo * 60000);
}

const MOCK_CONVERSATIONS = [
  {
    id: 100,
    participant_a_id: 1,
    participant_b_id: 2,
    otherId: 2,
    username: 'bob',
    usernode_pubkey: 'ut1bob456',
    verified_at: null,
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=bob',
    contact_id: null,
    contact_nickname: null,
    lastMessage: 'Hey, how are you doing today?',
    msg_created_at: getTimeOffset(15),
    unreadCount: 2,
    muted_by: [],
    archived_by: [],
    status_a: 'accepted',
    status_b: 'accepted',
    isMuted: false,
    isPending: false,
    myStatus: 'accepted'
  },
  {
    id: 101,
    participant_a_id: 1,
    participant_b_id: 3,
    otherId: 3,
    username: 'charlie',
    usernode_pubkey: 'ut1charlie789',
    verified_at: '2024-02-20T14:30:00Z',
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=charlie',
    contact_id: null,
    contact_nickname: 'Dev buddy',
    lastMessage: '[Image]',
    msg_created_at: getTimeOffset(120),
    unreadCount: 0,
    muted_by: [],
    archived_by: [],
    status_a: 'accepted',
    status_b: 'accepted',
    isMuted: false,
    isPending: false,
    myStatus: 'accepted'
  },
  {
    id: 102,
    participant_a_id: 1,
    participant_b_id: 4,
    otherId: 4,
    username: 'diana',
    usernode_pubkey: 'ut1diana101',
    verified_at: '2024-03-10T09:15:00Z',
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=diana',
    contact_id: null,
    contact_nickname: null,
    lastMessage: 'That sounds amazing! Let\'s catch up soon.',
    msg_created_at: getTimeOffset(480),
    unreadCount: 0,
    muted_by: [],
    archived_by: [],
    status_a: 'accepted',
    status_b: 'accepted',
    isMuted: false,
    isPending: false,
    myStatus: 'accepted'
  },
  {
    id: 103,
    participant_a_id: 1,
    participant_b_id: 5,
    otherId: 5,
    username: 'eve',
    usernode_pubkey: null,
    verified_at: null,
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=eve',
    contact_id: null,
    contact_nickname: null,
    lastMessage: 'Hi, nice to meet you!',
    msg_created_at: getTimeOffset(1440),
    unreadCount: 1,
    muted_by: [],
    archived_by: [],
    status_a: 'accepted',
    status_b: 'pending',
    isMuted: false,
    isPending: true,
    myStatus: 'pending'
  }
];

const MOCK_USER_STATS = {
  foregroundHours: 45,
  contributionLevel: 1.125,
  rank: 'Active Guardian',
  hoursBracket: '10-50',
  totalMessagesCount: 128,
  blockchainTransactionsCount: 23
};

function getMockConversations(userId, limit = 50, offset = 0) {
  const convs = MOCK_CONVERSATIONS.filter(c =>
    c.participant_a_id === userId || c.participant_b_id === userId
  ).map(conv => ({
    id: conv.id,
    otherId: conv.otherId,
    username: conv.username,
    usernode_pubkey: conv.usernode_pubkey,
    verified: !!conv.verified_at,
    avatar_url: conv.avatar_url,
    nickname: conv.contact_nickname,
    lastMessage: conv.lastMessage,
    lastMessageAt: conv.msg_created_at,
    unreadCount: conv.unreadCount,
    isMuted: conv.muted_by?.includes(userId) || false,
    isPending: conv.isPending,
    myStatus: conv.myStatus
  }));

  const active = convs.filter(c => !c.isPending && c.myStatus !== 'ignored');
  const pending = convs.filter(c => c.isPending && c.myStatus !== 'ignored');

  return {
    active: active.slice(offset, offset + limit),
    pending: pending.slice(offset, offset + limit),
    archived: []
  };
}


function getMockUserProfile(userId) {
  const user = MOCK_USERS.find(u => u.id === userId);
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    usernode_pubkey: user.usernode_pubkey,
    verified_at: user.verified_at,
    avatar_url: user.avatar_url,
    bio: user.bio,
    created_at: '2024-01-01T00:00:00Z'
  };
}

function getMockSearchUsers(query, limit = 20) {
  const lowerQuery = query.toLowerCase();
  const results = MOCK_USERS.filter(u =>
    u.username.toLowerCase().includes(lowerQuery) ||
    (u.bio && u.bio.toLowerCase().includes(lowerQuery))
  ).map(u => ({
    id: u.id,
    username: u.username,
    verified: !!u.verified_at,
    avatar_url: u.avatar_url,
    bio: u.bio
  }));

  return { results: results.slice(0, limit) };
}

function getMockUserMessages(userId, limit = 50, offset = 0) {
  const mockMessages = [
    {
      id: 1000,
      conversation_id: 100,
      sender_id: userId,
      recipient_id: 2,
      recipientUsername: 'bob',
      content: { text: 'Thanks for the update!' },
      type: 'text',
      created_at: getTimeOffset(50),
      blockchain_recorded: false
    },
    {
      id: 1001,
      conversation_id: 101,
      sender_id: userId,
      recipient_id: 3,
      recipientUsername: 'charlie',
      content: { text: 'Your suggestion was really helpful' },
      type: 'text',
      created_at: getTimeOffset(100),
      blockchain_recorded: false
    }
  ];

  return {
    messages: mockMessages.slice(offset, offset + limit),
    total: mockMessages.length
  };
}

function getMockFeedPosts(userId, limit = 20, offset = 0) {
  const mockPosts = [
    {
      id: 7000,
      author_id: 1,
      authorUsername: 'alice',
      content: 'Just launched a new feature!',
      created_at: getTimeOffset(120),
      likeCount: 45,
      commentCount: 8
    },
    {
      id: 7001,
      author_id: 3,
      authorUsername: 'charlie',
      content: 'Working on some exciting improvements',
      created_at: getTimeOffset(480),
      likeCount: 32,
      commentCount: 5
    }
  ];

  return {
    posts: mockPosts.slice(offset, offset + limit),
    total: mockPosts.length
  };
}

function getMockTransactionsByUser(userId, limit = 20, offset = 0) {
  const mockTxs = [
    {
      id: 9000,
      user_id: userId,
      tx_hash: 'demo-tx-hash-001',
      message_type: 'message',
      status: 'confirmed',
      confirmed_at: getTimeOffset(30),
      created_at: getTimeOffset(45),
      recipientUsername: 'bob'
    },
    {
      id: 9002,
      user_id: userId,
      tx_hash: 'demo-tx-hash-token-001',
      message_type: 'token_transfer',
      status: 'confirmed',
      confirmed_at: getTimeOffset(60),
      created_at: getTimeOffset(75),
      recipientUsername: 'alice'
    },
    {
      id: 9001,
      user_id: userId,
      tx_hash: 'demo-tx-hash-002',
      message_type: 'group_create',
      status: 'confirmed',
      confirmed_at: getTimeOffset(120),
      created_at: getTimeOffset(135),
      groupName: 'Project Alpha'
    }
  ];

  return {
    transactions: mockTxs.slice(offset, offset + limit),
    total: mockTxs.length
  };
}

module.exports = {
  getMockConversations,
  getMockUserProfile,
  getMockSearchUsers,
  getMockUserMessages,
  getMockFeedPosts,
  getMockTransactionsByUser,
  MOCK_USER_STATS,
  MOCK_USERS,
  MOCK_CONVERSATIONS
};
