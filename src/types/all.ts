export type NetworkType = 'testnet' | 'devnet' | 'mainnet';

export interface User {
  id: string;
  username: string;
  usernode_pubkey: string | null;
}

export interface ConversationMessage {
  id: string;
  sender_id: string;
  sender_username: string;
  recipient_id: string;
  recipient_username: string;
  content: string;
  timestamp: string;
  seen: boolean;
}

export interface Contact {
  id: string;
  username: string;
  address: string;
  nickname?: string;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
}
