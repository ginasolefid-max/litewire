export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read';

export type ScreenRoute =
  | 'splash'
  | 'login'
  | 'register'
  | 'chats'
  | 'chat'
  | 'search'
  | 'profile'
  | 'settings';

export type WorkspaceTab = 'messenger' | 'architecture';

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  publicKey: string;
  online: boolean;
  lastSeen: number;
}

export interface WireMessage {
  id: string;
  cid: string;
  convoId: string;
  seq: number;
  sid: string;
  ct: string;
  iv: string;
  ts: number;
  st: 'sent' | 'delivered' | 'read';
}

export interface DecryptedMessage {
  id: string;
  cid: string;
  convoId: string;
  seq: number;
  sid: string;
  plaintext: string;
  ts: number;
  st: MessageStatus;
  deletedLocally?: boolean;
}

export interface ConversationSummary {
  id: string;
  updatedAt: number;
  unreadCount: number;
  peer: UserProfile;
  lastPreview: string;
  lastTimestamp: number;
  hasMore?: boolean;
}

export interface PendingQueueItem {
  cid: string;
  convoId: string;
  ct: string;
  iv: string;
  plaintext: string;
  ts: number;
}

export interface DataTelemetry {
  bytesSentExact: number;
  bytesReceivedExact: number;
  estimatedOverheadBytes: number;
  messagesSent: number;
  messagesReceived: number;
}

export interface AndroidProjectFile {
  path: string;
  content: string;
  sizeBytes: number;
}
