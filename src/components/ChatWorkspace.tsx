import { ChangeEvent, DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Film,
  Image as ImageIcon,
  Lock,
  LogOut,
  MessageSquarePlus,
  Moon,
  Music,
  Paperclip,
  Phone,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  User,
  Video,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  CallType,
  ConversationSummary,
  DataTelemetry,
  DecryptedMessage,
  ScreenRoute,
  UserProfile,
} from '../types/messaging';
import { computeSafetyFingerprint } from '../crypto/e2ee';
import { formatBytes } from '../services/bandwidth';
import AttachmentBubble from './AttachmentBubble';
import PWAInstallButton from './PWAInstallButton';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB maximum

interface ChatWorkspaceProps {
  currentUser: UserProfile;
  route: ScreenRoute;
  setRoute: (r: ScreenRoute) => void;
  conversations: ConversationSummary[];
  activeConvoId: string | null;
  onSelectConversation: (id: string) => void;
  messages: DecryptedMessage[];
  hasMoreMessages: boolean;
  onLoadOlderMessages: () => void;
  onSendMessage: (convoId: string, text: string) => Promise<void>;
  onSendAttachment: (
    convoId: string,
    file: File,
    caption: string,
    onProgress: (pct: number) => void
  ) => Promise<void>;
  onDeleteMessageLocally: (convoId: string, messageId: string) => void;
  onClearHistoryLocally: (convoId: string) => void;
  onStartChatWithUser: (peer: UserProfile) => Promise<void>;
  onStartCall: (convoId: string, peer: UserProfile, callType: CallType) => void;
  callActive: boolean;
  searchResults: UserProfile[];
  searchingUsers: boolean;
  onSearchUsers: (query: string) => void;
  connectionStatus: 'connected' | 'reconnecting' | 'offline';
  backoffAttempt: number;
  pendingCount: number;
  simulatedOffline: boolean;
  onToggleSimulatedOffline: () => void;
  telemetry: DataTelemetry;
  onResetTelemetry: () => void;
  onAttachmentBytesReceived: (bytes: number) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onTestNotification: () => void;
  onLogout: () => Promise<void>;
  authToken: string;
}

export default function ChatWorkspace({
  currentUser,
  route,
  setRoute,
  conversations,
  activeConvoId,
  onSelectConversation,
  messages,
  hasMoreMessages,
  onLoadOlderMessages,
  onSendMessage,
  onSendAttachment,
  onDeleteMessageLocally,
  onClearHistoryLocally,
  onStartChatWithUser,
  onStartCall,
  callActive,
  searchResults,
  searchingUsers,
  onSearchUsers,
  connectionStatus,
  backoffAttempt,
  pendingCount,
  simulatedOffline,
  onToggleSimulatedOffline,
  telemetry,
  onResetTelemetry,
  onAttachmentBytesReceived,
  darkMode,
  onToggleDarkMode,
  notificationsEnabled,
  onToggleNotifications,
  soundEnabled,
  onToggleSound,
  onTestNotification,
  onLogout,
  authToken,
}: ChatWorkspaceProps) {
  const [draft, setDraft] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [showFingerprintModal, setShowFingerprintModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeConvo = conversations.find((c) => c.id === activeConvoId) || null;
  const visibleMessages = messages.filter((m) => !m.deletedLocally);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages.length, activeConvoId]);

  useEffect(() => {
    if (route === 'search') {
      onSearchUsers(searchQuery);
    }
  }, [route]);

  // Reset staged attachment when switching conversations
  useEffect(() => {
    setSelectedFile(null);
    setAttachmentError(null);
    setUploadProgress(0);
  }, [activeConvoId]);

  async function handleOpenFingerprint() {
    if (!activeConvo) return;
    const fp = await computeSafetyFingerprint(currentUser.publicKey, activeConvo.peer.publicKey);
    setFingerprint(fp);
    setShowFingerprintModal(true);
  }

  function validateAndStageFile(file: File | undefined | null) {
    if (!file) return;
    setAttachmentError(null);
    if (file.size === 0) {
      setAttachmentError('Cannot send an empty file.');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError(
        `File exceeds the 100 MB maximum limit (selected: ${formatBytes(file.size)}).`
      );
      return;
    }
    setSelectedFile(file);
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    validateAndStageFile(file);
    e.target.value = '';
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    if (activeConvo && !uploading) {
      setIsDraggingOver(true);
    }
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setIsDraggingOver(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setIsDraggingOver(false);
    if (!activeConvo || uploading) return;
    const file = e.dataTransfer.files?.[0];
    validateAndStageFile(file);
  }

  async function handleSendSubmit(e: FormEvent) {
    e.preventDefault();
    if (!activeConvoId || uploading) return;

    if (selectedFile) {
      if (connectionStatus !== 'connected') {
        setAttachmentError('Connect to the network before sending files or videos.');
        return;
      }
      const fileToSend = selectedFile;
      const caption = draft.trim();
      setUploading(true);
      setUploadProgress(0);
      setAttachmentError(null);
      try {
        await onSendAttachment(activeConvoId, fileToSend, caption, setUploadProgress);
        setSelectedFile(null);
        setDraft('');
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : 'Failed to upload attachment.');
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
      return;
    }

    if (!draft.trim()) return;
    const text = draft;
    setDraft('');
    await onSendMessage(activeConvoId, text);
  }

  const totalExactBytes = telemetry.bytesSentExact + telemetry.bytesReceivedExact;
  const totalWithOverhead = totalExactBytes + telemetry.estimatedOverheadBytes;
  const totalMsgs = telemetry.messagesSent + telemetry.messagesReceived;
  const avgPerMessage = totalMsgs > 0 ? Math.round(totalWithOverhead / totalMsgs) : 0;

  const sidebarTab: 'chats' | 'search' | 'profile' | 'settings' =
    route === 'search' || route === 'profile' || route === 'settings' ? route : 'chats';

  const isMobileChatOpen = route === 'chat' && activeConvo !== null;

  const stagedFileIcon = selectedFile
    ? selectedFile.type.startsWith('video/')
      ? Film
      : selectedFile.type.startsWith('image/')
      ? ImageIcon
      : selectedFile.type.startsWith('audio/')
      ? Music
      : FileText
    : FileText;
  const StagedIcon = stagedFileIcon;

  return (
    <div className="h-[calc(100vh-57px)] max-w-7xl mx-auto px-0 lg:px-6 lg:py-5">
      {showFingerprintModal && activeConvo && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-teal-600 dark:text-teal-400" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Encryption Safety Number
                </h3>
              </div>
              <button
                onClick={() => setShowFingerprintModal(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Messages with @{activeConvo.peer.username} are encrypted client-side using ECDH P-256 + HKDF-SHA256 + AES-256-GCM. Compare this SHA-256 fingerprint on both devices:
            </p>
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-center font-mono text-sm tracking-wider text-slate-900 dark:text-slate-100 select-all">
              {fingerprint}
            </div>
            <button
              onClick={() => setShowFingerprintModal(false)}
              className="w-full py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold"
            >
              Done
            </button>
          </div>
        </div>
      )}

      <div className="h-full grid grid-cols-1 lg:grid-cols-12 lg:gap-5">
        {/* LEFT PANE: Conversations / Search / Profile / Settings */}
        <aside
          className={`lg:col-span-4 h-full flex flex-col bg-white dark:bg-slate-900 lg:border lg:border-slate-200 lg:dark:border-slate-800 lg:rounded-2xl overflow-hidden ${
            isMobileChatOpen ? 'hidden lg:flex' : 'flex'
          }`}
        >
          {/* Connection Status Bar */}
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {connectionStatus === 'connected' ? (
                <Wifi className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
              ) : (
                <WifiOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              )}
              <div className="text-xs truncate">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  @{currentUser.username}
                </span>
                <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
                <span className="text-slate-600 dark:text-slate-400">
                  {connectionStatus === 'connected'
                    ? 'Connected'
                    : connectionStatus === 'reconnecting'
                    ? `Reconnecting (attempt ${backoffAttempt})`
                    : simulatedOffline
                    ? 'Simulated Offline'
                    : 'Offline'}
                </span>
                {pendingCount > 0 && (
                  <>
                    <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-amber-600 dark:text-amber-400 font-medium">
                      {pendingCount} queued
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              onClick={() => {
                setRoute('search');
                onSearchUsers('');
              }}
              className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
              title="New Encrypted Chat"
              aria-label="New Encrypted Chat"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
          </div>

          {/* Left Pane Body */}
          <div className="flex-1 overflow-y-auto">
            {sidebarTab === 'chats' && (
              <div>
                {conversations.length === 0 ? (
                  <div className="p-8 text-center space-y-4">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      No conversations yet
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Find another registered user by @username to start an end-to-end encrypted chat.
                    </p>
                    <button
                      onClick={() => {
                        setRoute('search');
                        onSearchUsers('');
                      }}
                      className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold"
                    >
                      Search Users
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
                    {conversations.map((c) => {
                      const selected = c.id === activeConvoId;
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            onSelectConversation(c.id);
                            setRoute('chat');
                          }}
                          className={`w-full text-left px-4 py-3.5 flex items-start justify-between gap-3 transition-colors ${
                            selected
                              ? 'bg-teal-50/80 dark:bg-teal-950/40'
                              : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                          }`}
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {c.peer.displayName}
                              </span>
                              <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                @{c.peer.username}
                              </span>
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
                              {c.lastPreview || 'Encrypted conversation'}
                            </p>
                          </div>

                          <div className="text-right shrink-0 space-y-1">
                            <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {c.lastTimestamp > 0
                                ? new Date(c.lastTimestamp).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : ''}
                            </div>
                            <div className="flex items-center justify-end gap-2 text-[11px]">
                              <span
                                className={
                                  c.peer.online
                                    ? 'text-teal-700 dark:text-teal-400 font-medium'
                                    : 'text-slate-400 dark:text-slate-500'
                                }
                              >
                                {c.peer.online ? 'Online' : 'Offline'}
                              </span>
                              {c.unreadCount > 0 && (
                                <span className="font-mono tabular-nums font-bold text-teal-700 dark:text-teal-400">
                                  · {c.unreadCount} new
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {sidebarTab === 'search' && (
              <div className="p-4 space-y-4">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      onSearchUsers(e.target.value);
                    }}
                    placeholder="Search @username..."
                    className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>

                {searchingUsers ? (
                  <p className="text-xs text-slate-500">Searching directory...</p>
                ) : searchResults.length === 0 ? (
                  <div className="py-6 text-center space-y-2">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      No other matching users found yet.
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">
                      Open a second tab and register another @username to test live messaging.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {searchResults.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => onStartChatWithUser(u)}
                        className="w-full py-3 px-2 text-left flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg transition-colors"
                      >
                        <div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {u.displayName}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            @{u.username}
                          </div>
                        </div>
                        <span
                          className={`text-xs font-medium ${
                            u.online ? 'text-teal-700 dark:text-teal-400' : 'text-slate-400'
                          }`}
                        >
                          {u.online ? 'Online' : 'Offline'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {sidebarTab === 'profile' && (
              <div className="p-5 space-y-5">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                    {currentUser.displayName}
                  </h3>
                  <p className="text-sm text-teal-700 dark:text-teal-400 font-medium">
                    @{currentUser.username}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    Public Identity Key (ECDH P-256 SPKI)
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] break-all text-slate-700 dark:text-slate-300">
                    {currentUser.publicKey}
                  </div>
                </div>

                <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed space-y-1">
                  <p>Private key storage: Local browser key store (never sent to server).</p>
                  <p>Password security: scrypt KDF + per-user 16-byte salt.</p>
                </div>

                <button
                  onClick={onLogout}
                  className="w-full py-2.5 px-4 rounded-lg border border-red-300 dark:border-red-900 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-semibold inline-flex items-center justify-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Secure Logout & Invalidate Session</span>
                </button>
              </div>
            )}

            {sidebarTab === 'settings' && (
              <div className="p-5 space-y-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Appearance
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {darkMode ? 'Dark mode active' : 'Light mode active'}
                    </div>
                  </div>
                  <button
                    onClick={onToggleDarkMode}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    <span>{darkMode ? 'Light' : 'Dark'}</span>
                  </button>
                </div>

                <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Simulate Offline / Dead SIM
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Queue outgoing messages & test auto-sync
                    </div>
                  </div>
                  <button
                    onClick={onToggleSimulatedOffline}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      simulatedOffline
                        ? 'bg-amber-600 text-white'
                        : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {simulatedOffline ? 'Go Online' : 'Go Offline'}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Message Sound Effects
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Play chime when new chat messages arrive
                    </div>
                  </div>
                  <button
                    onClick={onToggleSound}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${
                      soundEnabled
                        ? 'bg-teal-600 text-white'
                        : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                    <span>{soundEnabled ? 'On' : 'Muted'}</span>
                  </button>
                </div>

                <div className="space-y-2.5 pt-4 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Message Notifications
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Desktop & in-app alerts on arriving messages
                      </div>
                    </div>
                    <button
                      onClick={onToggleNotifications}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${
                        notificationsEnabled
                          ? 'bg-teal-600 text-white'
                          : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <Bell className="w-3.5 h-3.5" />
                      <span>{notificationsEnabled ? 'Enabled' : 'Enable'}</span>
                    </button>
                  </div>
                  <button
                    onClick={onTestNotification}
                    className="w-full py-2 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    Test Notification & Arrival Sound
                  </button>
                </div>

                <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Install on Phone
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Works even if IT admin blocks APKs
                    </div>
                  </div>
                  <PWAInstallButton variant="secondary" />
                </div>

                {/* Data Consumption Monitor */}
                <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Data Consumption Monitor
                    </h4>
                    <button
                      onClick={onResetTelemetry}
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Reset</span>
                    </button>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Connection Status</span>
                      <span className="font-mono font-medium text-slate-900 dark:text-slate-100 capitalize">
                        {connectionStatus}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Payload Sent (Exact UTF-8)</span>
                      <span className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100">
                        {formatBytes(telemetry.bytesSentExact)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Payload Received (Exact UTF-8)</span>
                      <span className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100">
                        {formatBytes(telemetry.bytesReceivedExact)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Transport Overhead (Estimated)</span>
                      <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {formatBytes(telemetry.estimatedOverheadBytes)}
                      </span>
                    </div>
                    <div className="flex justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Total Messaging Data</span>
                      <span className="font-mono tabular-nums font-bold text-teal-700 dark:text-teal-400">
                        {formatBytes(totalWithOverhead)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Messages Sent / Received</span>
                      <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {telemetry.messagesSent} / {telemetry.messagesReceived}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Avg. Data per Message</span>
                      <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {avgPerMessage} B
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    Application JSON & ciphertext bytes are exact measurements via TextEncoder. TCP/TLS/WS framing (~64 B/packet) is estimated. Works without a data promo; carrier pay-per-use fees may apply.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Tab Bar */}
          <nav className="grid grid-cols-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            {[
              { id: 'chats' as const, label: 'Chats', icon: Lock },
              { id: 'search' as const, label: 'Search', icon: Search },
              { id: 'profile' as const, label: 'Profile', icon: User },
              { id: 'settings' as const, label: 'Settings', icon: Settings },
            ].map((tab) => {
              const Icon = tab.icon;
              const active = sidebarTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setRoute(tab.id)}
                  className={`py-2.5 flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors min-h-[48px] ${
                    active
                      ? 'text-teal-700 dark:text-teal-400'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* RIGHT PANE: Private Chat Screen */}
        <section
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`lg:col-span-8 h-full flex flex-col bg-white dark:bg-slate-900 lg:border lg:border-slate-200 lg:dark:border-slate-800 lg:rounded-2xl overflow-hidden relative ${
            isMobileChatOpen ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {isDraggingOver && (
            <div className="absolute inset-0 z-30 bg-teal-600/15 backdrop-blur-[2px] border-2 border-dashed border-teal-500 rounded-2xl flex items-center justify-center pointer-events-none">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl px-6 py-4 text-center shadow-lg">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Drop file or video to encrypt & send
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Maximum size: 100 MB
                </p>
              </div>
            </div>
          )}

          {!activeConvo ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <Lock className="w-5 h-5 text-teal-600 dark:text-teal-400" />
              </div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Select or start an encrypted conversation
              </h2>
              <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                All private messages, files, and videos (up to 100 MB) are encrypted client-side with ECDH P-256 and AES-256-GCM before leaving your device.
              </p>
            </div>
          ) : (
            <>
              {/* Chat Header */}
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    onClick={() => setRoute('chats')}
                    className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    aria-label="Back to chats"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {activeConvo.peer.displayName}
                      </h2>
                      <span className="text-xs text-slate-500 dark:text-slate-400 truncate hidden sm:inline">
                        @{activeConvo.peer.username}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <span
                        className={
                          activeConvo.peer.online
                            ? 'text-teal-700 dark:text-teal-400 font-medium'
                            : ''
                        }
                      >
                        {activeConvo.peer.online ? 'Online' : 'Offline'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">End-to-end encrypted</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => onStartCall(activeConvo.id, activeConvo.peer, 'audio')}
                    disabled={connectionStatus !== 'connected' || callActive}
                    className="inline-flex items-center justify-center gap-1.5 min-h-[38px] min-w-[38px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                    title="Start Audio Call"
                    aria-label="Audio call"
                  >
                    <Phone className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                    <span className="hidden md:inline">Audio</span>
                  </button>
                  <button
                    onClick={() => onStartCall(activeConvo.id, activeConvo.peer, 'video')}
                    disabled={connectionStatus !== 'connected' || callActive}
                    className="inline-flex items-center justify-center gap-1.5 min-h-[38px] min-w-[38px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                    title="Start Video Call"
                    aria-label="Video call"
                  >
                    <Video className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                    <span className="hidden md:inline">Video</span>
                  </button>
                  <button
                    onClick={handleOpenFingerprint}
                    className="inline-flex items-center justify-center gap-1.5 min-h-[38px] min-w-[38px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    title="Verify Encryption Keys"
                    aria-label="Verify Encryption Keys"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                    <span className="hidden xl:inline">Verify Keys</span>
                  </button>
                  <button
                    onClick={() => onClearHistoryLocally(activeConvo.id)}
                    className="inline-flex items-center justify-center gap-1.5 min-h-[38px] min-w-[38px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    title="Clear conversation history on this device only"
                    aria-label="Clear history locally"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span className="hidden xl:inline">Clear</span>
                  </button>
                </div>
              </div>

              {/* Offline Queue Banner */}
              {connectionStatus !== 'connected' && (
                <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between">
                  <span>
                    Offline mode: new messages are encrypted, saved locally as Pending, and auto-sync on reconnect.
                  </span>
                  {pendingCount > 0 && (
                    <span className="font-mono tabular-nums font-semibold">{pendingCount} pending</span>
                  )}
                </div>
              )}

              {/* Message Feed */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-slate-50/70 dark:bg-slate-950/60">
                {hasMoreMessages && (
                  <div className="text-center pb-2">
                    <button
                      onClick={onLoadOlderMessages}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Load older messages
                    </button>
                  </div>
                )}

                {visibleMessages.length === 0 ? (
                  <div className="py-16 text-center text-xs text-slate-500 dark:text-slate-400">
                    No messages yet. Send an encrypted message, file, or video below.
                  </div>
                ) : (
                  visibleMessages.map((msg) => {
                    const isMine = msg.sid === currentUser.id;
                    return (
                      <div
                        key={msg.cid || msg.id}
                        className={`flex ${isMine ? 'justify-end' : 'justify-start'} group`}
                      >
                        <div className="flex items-end gap-1.5 max-w-[85%] sm:max-w-[72%]">
                          {isMine && (
                            <button
                              onClick={() => onDeleteMessageLocally(activeConvo.id, msg.id)}
                              className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-md text-slate-400 hover:text-red-600 transition-opacity"
                              title="Delete locally"
                              aria-label="Delete message locally"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <div
                            className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                              isMine
                                ? 'bg-teal-600 text-white rounded-br-sm'
                                : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-800 rounded-bl-sm'
                            }`}
                          >
                            {msg.attachment ? (
                              <AttachmentBubble
                                attachment={msg.attachment}
                                authToken={authToken}
                                isMine={isMine}
                                onBytesReceived={onAttachmentBytesReceived}
                              />
                            ) : (
                              <p className="whitespace-pre-wrap">{msg.plaintext}</p>
                            )}

                            <div
                              className={`mt-1.5 flex items-center justify-end gap-1 text-[11px] font-mono tabular-nums ${
                                isMine ? 'text-teal-100' : 'text-slate-400 dark:text-slate-500'
                              }`}
                            >
                              <span>
                                {new Date(msg.ts).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                              {isMine && (
                                <span className="inline-flex items-center gap-0.5 ml-1" title={msg.st}>
                                  {msg.st === 'pending' && (
                                    <>
                                      <Clock className="w-3 h-3" />
                                      <span>Pending</span>
                                    </>
                                  )}
                                  {msg.st === 'sent' && (
                                    <>
                                      <Check className="w-3 h-3" />
                                      <span>Sent</span>
                                    </>
                                  )}
                                  {msg.st === 'delivered' && (
                                    <>
                                      <CheckCheck className="w-3 h-3" />
                                      <span>Delivered</span>
                                    </>
                                  )}
                                  {msg.st === 'read' && (
                                    <>
                                      <CheckCheck className="w-3 h-3 text-white" />
                                      <span className="font-semibold text-white">Read</span>
                                    </>
                                  )}
                                </span>
                              )}
                            </div>
                          </div>

                          {!isMine && (
                            <button
                              onClick={() => onDeleteMessageLocally(activeConvo.id, msg.id)}
                              className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-md text-slate-400 hover:text-red-600 transition-opacity"
                              title="Delete locally"
                              aria-label="Delete message locally"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Staged Attachment / Upload Progress / Error Bar */}
              {(selectedFile || attachmentError) && (
                <div className="px-3 pt-2.5 pb-1 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 space-y-2">
                  {attachmentError && (
                    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                      <span>{attachmentError}</span>
                      <button
                        type="button"
                        onClick={() => setAttachmentError(null)}
                        className="p-0.5 hover:opacity-75"
                        aria-label="Dismiss error"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {selectedFile && (
                    <div className="px-3 py-2 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <StagedIcon className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {selectedFile.name}
                            </p>
                            <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {formatBytes(selectedFile.size)} · Max 100 MB · Encrypted before upload
                            </p>
                          </div>
                        </div>
                        {!uploading && (
                          <button
                            type="button"
                            onClick={() => setSelectedFile(null)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                            aria-label="Remove attachment"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      {uploading && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] font-mono tabular-nums text-teal-700 dark:text-teal-400">
                            <span>Encrypting & uploading...</span>
                            <span>{uploadProgress}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-teal-600 transition-all duration-150"
                              style={{ width: `${uploadProgress}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Message Composer */}
              <form
                onSubmit={handleSendSubmit}
                className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="*/*"
                  onChange={handleFileInputChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="h-10 w-10 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 flex items-center justify-center transition-colors shrink-0"
                  title="Attach file or video (max 100 MB)"
                  aria-label="Attach file or video"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={uploading}
                  placeholder={
                    selectedFile
                      ? 'Add an optional caption...'
                      : 'Write an encrypted message or attach a file/video (max 100 MB)...'
                  }
                  className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <button
                  type="submit"
                  disabled={uploading || (!draft.trim() && !selectedFile)}
                  className="h-10 w-10 rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white flex items-center justify-center transition-colors shrink-0"
                  aria-label="Send message"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
