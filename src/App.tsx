import { useCallback, useEffect, useRef, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import AuthViews from './components/AuthViews';
import ChatWorkspace from './components/ChatWorkspace';
import AndroidStudioView from './components/AndroidStudioView';
import {
  decryptMessage,
  encryptMessage,
  getOrCreateIdentityKeyPair,
} from './crypto/e2ee';
import {
  addInboundTelemetry,
  addOutboundTelemetry,
  loadTelemetry,
  saveTelemetry,
} from './services/bandwidth';
import {
  ConversationSummary,
  DataTelemetry,
  DecryptedMessage,
  PendingQueueItem,
  ScreenRoute,
  UserProfile,
  WireMessage,
  WorkspaceTab,
} from './types/messaging';

function loadLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  return fallback;
}

export default function App() {
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('messenger');
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('litewire_theme') === 'dark';
  });

  const [route, setRoute] = useState<ScreenRoute>('splash');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [authToken, setAuthToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === '1') {
      sessionStorage.removeItem('litewire_session_token');
      return null;
    }
    return (
      sessionStorage.getItem('litewire_session_token') ||
      localStorage.getItem('litewire_last_token')
    );
  });

  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const privateKeyRef = useRef<CryptoKey | null>(null);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);
  const [messagesByConvo, setMessagesByConvo] = useState<Record<string, DecryptedMessage[]>>({});
  const [hasMoreByConvo, setHasMoreByConvo] = useState<Record<string, boolean>>({});
  const [pendingQueue, setPendingQueue] = useState<PendingQueueItem[]>([]);

  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);

  const [simulatedOffline, setSimulatedOffline] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting' | 'offline'>('offline');
  const [backoffAttempt, setBackoffAttempt] = useState(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  const [telemetry, setTelemetry] = useState<DataTelemetry>({
    bytesSentExact: 0,
    bytesReceivedExact: 0,
    estimatedOverheadBytes: 0,
    messagesSent: 0,
    messagesReceived: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastSeqRef = useRef<number>(0);
  const conversationsRef = useRef<ConversationSummary[]>([]);
  const activeConvoRef = useRef<string | null>(null);
  const currentUserRef = useRef<UserProfile | null>(null);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    activeConvoRef.current = activeConvoId;
  }, [activeConvoId]);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // Sync Tailwind .dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('litewire_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Monitor OS online/offline events
  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const recordOutbound = useCallback((payloadStr: string, isChatMsg: boolean) => {
    const uid = currentUserRef.current?.id;
    if (!uid) return;
    setTelemetry((prev) => {
      const next = addOutboundTelemetry(prev, payloadStr, isChatMsg);
      saveTelemetry(uid, next);
      return next;
    });
  }, []);

  const recordInbound = useCallback((payloadStr: string, isChatMsg: boolean) => {
    const uid = currentUserRef.current?.id;
    if (!uid) return;
    setTelemetry((prev) => {
      const next = addInboundTelemetry(prev, payloadStr, isChatMsg);
      saveTelemetry(uid, next);
      return next;
    });
  }, []);

  // Persist local message cache whenever it updates
  useEffect(() => {
    if (!currentUser) return;
    localStorage.setItem(`litewire_msgs_${currentUser.id}`, JSON.stringify(messagesByConvo));
  }, [messagesByConvo, currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    localStorage.setItem(`litewire_convos_${currentUser.id}`, JSON.stringify(conversations));
  }, [conversations, currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    localStorage.setItem(`litewire_queue_${currentUser.id}`, JSON.stringify(pendingQueue));
  }, [pendingQueue, currentUser]);

  const decryptWireMessage = useCallback(
    async (wire: WireMessage, peerPublicKey?: string): Promise<DecryptedMessage> => {
      const priv = privateKeyRef.current;
      let pub = peerPublicKey;
      if (!pub) {
        const convo = conversationsRef.current.find((c) => c.id === wire.convoId);
        pub = convo?.peer.publicKey;
      }

      let plaintext = '[Encrypted message]';
      if (priv && pub) {
        try {
          plaintext = await decryptMessage(priv, pub, wire.convoId, wire.ct, wire.iv);
        } catch {
          plaintext = '[Unable to decrypt with current device key]';
        }
      }

      return {
        id: wire.id,
        cid: wire.cid,
        convoId: wire.convoId,
        seq: wire.seq,
        sid: wire.sid,
        plaintext,
        ts: wire.ts,
        st: wire.st,
      };
    },
    []
  );

  const upsertLocalMessage = useCallback((convoId: string, msg: DecryptedMessage) => {
    setMessagesByConvo((prev) => {
      const existingList = prev[convoId] || [];
      const idx = existingList.findIndex(
        (m) => m.id === msg.id || (m.cid && msg.cid && m.cid === msg.cid)
      );
      let nextList: DecryptedMessage[];
      if (idx >= 0) {
        const current = existingList[idx];
        nextList = [...existingList];
        nextList[idx] = {
          ...current,
          ...msg,
          deletedLocally: current.deletedLocally,
        };
      } else {
        nextList = [...existingList, msg].sort((a, b) => a.ts - b.ts);
      }
      return { ...prev, [convoId]: nextList };
    });

    setConversations((prev) =>
      prev
        .map((c) =>
          c.id === convoId
            ? {
                ...c,
                lastPreview: msg.plaintext,
                lastTimestamp: Math.max(c.lastTimestamp, msg.ts),
                updatedAt: Math.max(c.updatedAt, msg.ts),
              }
            : c
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    );
  }, []);

  const refreshConversations = useCallback(
    async (token: string) => {
      const res = await fetch('/api/conversations', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const rawText = await res.text();
      recordInbound(rawText, false);
      const data = JSON.parse(rawText) as {
        conversations: Array<{
          id: string;
          updatedAt: number;
          unreadCount: number;
          peer: UserProfile;
          lastMessage: WireMessage | null;
        }>;
        globalSeq: number;
      };

      const mapped: ConversationSummary[] = [];
      for (const c of data.conversations) {
        let preview = 'Encrypted conversation';
        if (c.lastMessage && privateKeyRef.current) {
          try {
            preview = await decryptMessage(
              privateKeyRef.current,
              c.peer.publicKey,
              c.id,
              c.lastMessage.ct,
              c.lastMessage.iv
            );
          } catch {
            preview = 'Encrypted message';
          }
        }
        mapped.push({
          id: c.id,
          updatedAt: c.updatedAt,
          unreadCount: c.unreadCount,
          peer: c.peer,
          lastPreview: preview,
          lastTimestamp: c.lastMessage?.ts || c.updatedAt,
        });
      }
      setConversations(mapped);
    },
    [recordInbound]
  );

  // Restore session on mount
  useEffect(() => {
    if (!authToken) {
      const t = window.setTimeout(() => {
        setRoute((r) => (r === 'splash' ? 'login' : r));
      }, 450);
      return () => clearTimeout(t);
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) {
          sessionStorage.removeItem('litewire_session_token');
          localStorage.removeItem('litewire_last_token');
          if (!cancelled) {
            setAuthToken(null);
            setRoute('login');
          }
          return;
        }
        const data = (await res.json()) as { user: UserProfile };
        const keys = await getOrCreateIdentityKeyPair(data.user.username);
        privateKeyRef.current = keys.privateKey;
        if (cancelled) return;

        setCurrentUser(data.user);
        setTelemetry(loadTelemetry(data.user.id));
        setMessagesByConvo(loadLocalJson(`litewire_msgs_${data.user.id}`, {}));
        setConversations(loadLocalJson(`litewire_convos_${data.user.id}`, []));
        setPendingQueue(loadLocalJson(`litewire_queue_${data.user.id}`, []));
        lastSeqRef.current = Number(localStorage.getItem(`litewire_seq_${data.user.id}`) || '0');
        setRoute('chats');
        await refreshConversations(authToken);
      } catch {
        if (!cancelled) setRoute('login');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authToken, refreshConversations]);

  // Flush pending offline queue over active WebSocket
  const flushPendingQueue = useCallback(() => {
    const ws = wsRef.current;
    const uid = currentUserRef.current?.id;
    if (!ws || ws.readyState !== WebSocket.OPEN || !uid) return;

    const queue = loadLocalJson<PendingQueueItem[]>(`litewire_queue_${uid}`, []);
    for (const item of queue) {
      const frame = JSON.stringify({
        t: 'm',
        c: item.convoId,
        cid: item.cid,
        ct: item.ct,
        iv: item.iv,
      });
      ws.send(frame);
      recordOutbound(frame, true);
    }
  }, [recordOutbound]);

  // WebSocket Connection with Exponential Backoff & Incremental Sync
  useEffect(() => {
    if (!authToken || !currentUser || simulatedOffline || !browserOnline) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setConnectionStatus('offline');
      return;
    }

    let disposed = false;
    let attempt = 0;

    function connect() {
      if (disposed || !authToken || !currentUser) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(authToken)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setBackoffAttempt(0);
        setConnectionStatus('connected');

        // 1. Request incremental delta sync since last known globalSeq
        const syncFrame = JSON.stringify({ t: 's', since: lastSeqRef.current });
        ws.send(syncFrame);
        recordOutbound(syncFrame, false);

        // 2. Flush any offline queued messages
        flushPendingQueue();
      };

      ws.onmessage = async (event) => {
        const raw = String(event.data || '');
        const msg = JSON.parse(raw);

        if (msg.t === 'm') {
          recordInbound(raw, true);
          if (msg.seq > lastSeqRef.current) {
            lastSeqRef.current = msg.seq;
            localStorage.setItem(`litewire_seq_${currentUser.id}`, String(msg.seq));
          }

          // Ensure conversation metadata exists locally if brand new peer
          let peerPub = conversationsRef.current.find((c) => c.id === msg.c)?.peer.publicKey;
          if (!peerPub) {
            await refreshConversations(authToken);
            peerPub = conversationsRef.current.find((c) => c.id === msg.c)?.peer.publicKey;
          }

          const wire: WireMessage = {
            id: msg.id,
            cid: msg.cid,
            convoId: msg.c,
            seq: msg.seq,
            sid: msg.sid,
            ct: msg.ct,
            iv: msg.iv,
            ts: msg.ts,
            st: msg.st,
          };
          const decrypted = await decryptWireMessage(wire, peerPub);
          upsertLocalMessage(wire.convoId, decrypted);

          // Send delivered ack
          const ackFrame = JSON.stringify({ t: 'd', c: wire.convoId, id: wire.id });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(ackFrame);
            recordOutbound(ackFrame, false);
          }

          // Mark read immediately if user is viewing this chat, else increment unread + notify
          if (activeConvoRef.current === wire.convoId && !document.hidden) {
            const readFrame = JSON.stringify({ t: 'r', c: wire.convoId, ids: [wire.id] });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(readFrame);
              recordOutbound(readFrame, false);
            }
          } else {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === wire.convoId ? { ...c, unreadCount: c.unreadCount + 1 } : c
              )
            );
            if (notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
              const peer = conversationsRef.current.find((c) => c.id === wire.convoId)?.peer;
              new Notification(peer ? `@${peer.username}` : 'LiteWire', {
                body: 'New end-to-end encrypted message',
              });
            }
          }
        } else if (msg.t === 'a') {
          recordInbound(raw, false);
          if (msg.seq > lastSeqRef.current) {
            lastSeqRef.current = msg.seq;
            localStorage.setItem(`litewire_seq_${currentUser.id}`, String(msg.seq));
          }
          // Remove from pending queue idempotently and update message status
          setPendingQueue((prev) => prev.filter((item) => item.cid !== msg.cid));
          setMessagesByConvo((prev) => {
            const list = prev[msg.c] || [];
            const updated = list.map((m) =>
              m.cid === msg.cid ? { ...m, id: msg.id, seq: msg.seq, ts: msg.ts, st: msg.st } : m
            );
            return { ...prev, [msg.c]: updated };
          });
        } else if (msg.t === 'st') {
          recordInbound(raw, false);
          setMessagesByConvo((prev) => {
            const list = prev[msg.c] || [];
            return {
              ...prev,
              [msg.c]: list.map((m) => (m.id === msg.id ? { ...m, st: msg.st } : m)),
            };
          });
        } else if (msg.t === 'p') {
          recordInbound(raw, false);
          setConversations((prev) =>
            prev.map((c) =>
              c.peer.id === msg.u ? { ...c, peer: { ...c.peer, online: msg.o, lastSeen: msg.ls } } : c
            )
          );
        } else if (msg.t === 'delta') {
          recordInbound(raw, (msg.msgs || []).length > 0);
          if (msg.seq > lastSeqRef.current) {
            lastSeqRef.current = msg.seq;
            localStorage.setItem(`litewire_seq_${currentUser.id}`, String(msg.seq));
          }
          const items = (msg.msgs || []) as WireMessage[];
          if (items.length > 0) {
            await refreshConversations(authToken);
            for (const wire of items) {
              const dec = await decryptWireMessage(wire);
              upsertLocalMessage(wire.convoId, dec);
            }
          }
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return;
        attempt += 1;
        setBackoffAttempt(attempt);
        setConnectionStatus('reconnecting');
        const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        const jitter = Math.floor(Math.random() * 400);
        reconnectTimerRef.current = window.setTimeout(connect, baseDelay + jitter);
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [
    authToken,
    currentUser,
    simulatedOffline,
    browserOnline,
    notificationsEnabled,
    decryptWireMessage,
    upsertLocalMessage,
    refreshConversations,
    flushPendingQueue,
    recordInbound,
    recordOutbound,
  ]);

  // Select conversation & fetch initial page + mark read
  const handleSelectConversation = useCallback(
    async (convoId: string) => {
      setActiveConvoId(convoId);
      setConversations((prev) =>
        prev.map((c) => (c.id === convoId ? { ...c, unreadCount: 0 } : c))
      );

      if (!authToken || simulatedOffline || !browserOnline) return;
      const existing = messagesByConvo[convoId] || [];
      const latestSeq = existing.reduce((max, m) => Math.max(max, m.seq || 0), 0);

      const url =
        latestSeq > 0
          ? `/api/conversations/${convoId}/messages?sinceSeq=${latestSeq}`
          : `/api/conversations/${convoId}/messages?limit=30`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const raw = await res.text();
      recordInbound(raw, false);
      const data = JSON.parse(raw) as { messages: WireMessage[]; hasMore: boolean };
      const convo = conversationsRef.current.find((c) => c.id === convoId);

      const unreadIds: string[] = [];
      for (const wire of data.messages) {
        const dec = await decryptWireMessage(wire, convo?.peer.publicKey);
        upsertLocalMessage(convoId, dec);
        if (wire.sid !== currentUserRef.current?.id && wire.st !== 'read') {
          unreadIds.push(wire.id);
        }
      }

      if (latestSeq === 0) {
        setHasMoreByConvo((prev) => ({ ...prev, [convoId]: data.hasMore }));
      }

      // Also mark existing unread local messages read
      for (const m of existing) {
        if (m.sid !== currentUserRef.current?.id && m.st !== 'read' && !unreadIds.includes(m.id)) {
          unreadIds.push(m.id);
        }
      }

      if (unreadIds.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
        const readFrame = JSON.stringify({ t: 'r', c: convoId, ids: unreadIds });
        wsRef.current.send(readFrame);
        recordOutbound(readFrame, false);
      }
    },
    [
      authToken,
      simulatedOffline,
      browserOnline,
      messagesByConvo,
      decryptWireMessage,
      upsertLocalMessage,
      recordInbound,
      recordOutbound,
    ]
  );

  const handleLoadOlderMessages = useCallback(async () => {
    if (!activeConvoId || !authToken || simulatedOffline || !browserOnline) return;
    const list = messagesByConvo[activeConvoId] || [];
    const oldestSeq = list.reduce((min, m) => (m.seq > 0 && m.seq < min ? m.seq : min), Infinity);
    if (!Number.isFinite(oldestSeq)) return;

    const res = await fetch(
      `/api/conversations/${activeConvoId}/messages?beforeSeq=${oldestSeq}&limit=30`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!res.ok) return;
    const raw = await res.text();
    recordInbound(raw, false);
    const data = JSON.parse(raw) as { messages: WireMessage[]; hasMore: boolean };
    const convo = conversationsRef.current.find((c) => c.id === activeConvoId);

    for (const wire of data.messages) {
      const dec = await decryptWireMessage(wire, convo?.peer.publicKey);
      upsertLocalMessage(activeConvoId, dec);
    }
    setHasMoreByConvo((prev) => ({ ...prev, [activeConvoId]: data.hasMore }));
  }, [
    activeConvoId,
    authToken,
    simulatedOffline,
    browserOnline,
    messagesByConvo,
    decryptWireMessage,
    upsertLocalMessage,
    recordInbound,
  ]);

  const handleRegister = async (username: string, displayName: string, password: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const keys = await getOrCreateIdentityKeyPair(username);
      privateKeyRef.current = keys.privateKey;
      const body = JSON.stringify({
        username,
        displayName,
        password,
        publicKey: keys.publicKeyBase64,
      });
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Registration failed.');
        return;
      }
      sessionStorage.setItem('litewire_session_token', data.token);
      localStorage.setItem('litewire_last_token', data.token);
      setAuthToken(data.token);
      setCurrentUser(data.user);
      setTelemetry(loadTelemetry(data.user.id));
      setRoute('chats');
    } catch {
      setAuthError('Network error while registering.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogin = async (username: string, password: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const keys = await getOrCreateIdentityKeyPair(username);
      privateKeyRef.current = keys.privateKey;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, publicKey: keys.publicKeyBase64 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Login failed.');
        return;
      }
      sessionStorage.setItem('litewire_session_token', data.token);
      localStorage.setItem('litewire_last_token', data.token);
      setAuthToken(data.token);
      setCurrentUser(data.user);
      setTelemetry(loadTelemetry(data.user.id));
      setMessagesByConvo(loadLocalJson(`litewire_msgs_${data.user.id}`, {}));
      setConversations(loadLocalJson(`litewire_convos_${data.user.id}`, []));
      setPendingQueue(loadLocalJson(`litewire_queue_${data.user.id}`, []));
      setRoute('chats');
      await refreshConversations(data.token);
    } catch {
      setAuthError('Network error while logging in.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (authToken) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      }).catch(() => {});
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    sessionStorage.removeItem('litewire_session_token');
    localStorage.removeItem('litewire_last_token');
    setAuthToken(null);
    setCurrentUser(null);
    setConversations([]);
    setMessagesByConvo({});
    setActiveConvoId(null);
    setRoute('login');
  };

  const handleSearchUsers = async (query: string) => {
    if (!authToken) return;
    setSearchingUsers(true);
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const raw = await res.text();
        recordInbound(raw, false);
        const data = JSON.parse(raw) as { users: UserProfile[] };
        setSearchResults(data.users);
      }
    } finally {
      setSearchingUsers(false);
    }
  };

  const handleStartChatWithUser = async (peer: UserProfile) => {
    if (!authToken) return;
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ peerId: peer.id }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const convoId = data.conversation.id as string;
    await refreshConversations(authToken);
    await handleSelectConversation(convoId);
    setRoute('chat');
  };

  const handleSendMessage = async (convoId: string, plaintext: string) => {
    if (!currentUser || !privateKeyRef.current) return;
    const convo = conversations.find((c) => c.id === convoId);
    if (!convo) return;

    const trimmed = plaintext.trim();
    if (!trimmed) return;

    const cid = crypto.randomUUID();
    const ts = Date.now();
    const { ct, iv } = await encryptMessage(
      privateKeyRef.current,
      convo.peer.publicKey,
      convoId,
      trimmed
    );

    // Optimistic local insert as pending
    upsertLocalMessage(convoId, {
      id: cid,
      cid,
      convoId,
      seq: 0,
      sid: currentUser.id,
      plaintext: trimmed,
      ts,
      st: 'pending',
    });

    const queueItem: PendingQueueItem = { cid, convoId, ct, iv, plaintext: trimmed, ts };
    setPendingQueue((prev) => [...prev, queueItem]);

    if (
      !simulatedOffline &&
      browserOnline &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      const frame = JSON.stringify({ t: 'm', c: convoId, cid, ct, iv });
      wsRef.current.send(frame);
      recordOutbound(frame, true);
    }
  };

  const handleDeleteMessageLocally = (convoId: string, messageId: string) => {
    setMessagesByConvo((prev) => ({
      ...prev,
      [convoId]: (prev[convoId] || []).map((m) =>
        m.id === messageId ? { ...m, deletedLocally: true } : m
      ),
    }));
  };

  const handleClearHistoryLocally = (convoId: string) => {
    setMessagesByConvo((prev) => ({
      ...prev,
      [convoId]: (prev[convoId] || []).map((m) => ({ ...m, deletedLocally: true })),
    }));
  };

  const handleToggleNotifications = async () => {
    if (!('Notification' in window)) return;
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      return;
    }
    const perm = await Notification.requestPermission();
    setNotificationsEnabled(perm === 'granted');
  };

  const handleResetTelemetry = () => {
    const empty: DataTelemetry = {
      bytesSentExact: 0,
      bytesReceivedExact: 0,
      estimatedOverheadBytes: 0,
      messagesSent: 0,
      messagesReceived: 0,
    };
    setTelemetry(empty);
    if (currentUser) saveTelemetry(currentUser.id, empty);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {/* Strict 3-Zone Top Bar */}
      <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-6 flex items-center justify-between gap-8">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setWorkspaceTab('messenger');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 font-display"
        >
          LiteWire
        </a>

        <nav className="flex items-center gap-6 text-sm font-medium">
          <button
            onClick={() => setWorkspaceTab('messenger')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              workspaceTab === 'messenger'
                ? 'border-teal-600 text-slate-900 dark:text-slate-100'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Live Messenger
          </button>
          <button
            onClick={() => setWorkspaceTab('architecture')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              workspaceTab === 'architecture'
                ? 'border-teal-600 text-slate-900 dark:text-slate-100'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Android Kotlin Project
          </button>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            onClick={() => setDarkMode((d) => !d)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            aria-label="Toggle theme"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{darkMode ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </header>

      {workspaceTab === 'architecture' ? (
        <AndroidStudioView />
      ) : !currentUser || route === 'splash' || route === 'login' || route === 'register' ? (
        <AuthViews
          route={route === 'register' ? 'register' : route === 'login' ? 'login' : 'splash'}
          loading={authLoading}
          error={authError}
          onNavigate={(r) => {
            setAuthError(null);
            setRoute(r);
          }}
          onLogin={handleLogin}
          onRegister={handleRegister}
        />
      ) : (
        <ChatWorkspace
          currentUser={currentUser}
          route={route}
          setRoute={setRoute}
          conversations={conversations}
          activeConvoId={activeConvoId}
          onSelectConversation={handleSelectConversation}
          messages={activeConvoId ? messagesByConvo[activeConvoId] || [] : []}
          hasMoreMessages={activeConvoId ? Boolean(hasMoreByConvo[activeConvoId]) : false}
          onLoadOlderMessages={handleLoadOlderMessages}
          onSendMessage={handleSendMessage}
          onDeleteMessageLocally={handleDeleteMessageLocally}
          onClearHistoryLocally={handleClearHistoryLocally}
          onStartChatWithUser={handleStartChatWithUser}
          searchResults={searchResults}
          searchingUsers={searchingUsers}
          onSearchUsers={handleSearchUsers}
          connectionStatus={connectionStatus}
          backoffAttempt={backoffAttempt}
          pendingCount={pendingQueue.length}
          simulatedOffline={simulatedOffline}
          onToggleSimulatedOffline={() => setSimulatedOffline((s) => !s)}
          telemetry={telemetry}
          onResetTelemetry={handleResetTelemetry}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          onLogout={handleLogout}
          authToken={authToken || ''}
        />
      )}
    </div>
  );
}
