import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Moon, Sun, X } from 'lucide-react';
import AuthViews from './components/AuthViews';
import ChatWorkspace from './components/ChatWorkspace';
import AndroidStudioView from './components/AndroidStudioView';
import CallModal from './components/CallModal';
import { cacheDecryptedAttachmentUrl } from './components/AttachmentBubble';
import {
  decodeMessageEnvelope,
  decryptMessage,
  encodeAttachmentEnvelope,
  encryptFileBuffer,
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
  playCallEndTone,
  playMessageArriveSound,
  startRingtoneLoop,
  unlockAudio,
} from './services/sound';
import {
  AttachmentKind,
  AttachmentPayload,
  CallSessionState,
  CallType,
  ConversationSummary,
  DataTelemetry,
  DecryptedMessage,
  IncomingToast,
  PendingQueueItem,
  ScreenRoute,
  UserProfile,
  WireMessage,
  WorkspaceTab,
} from './types/messaging';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function loadLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  return fallback;
}

function detectAttachmentKind(mimeType: string, fileName: string): AttachmentKind {
  const mime = mimeType.toLowerCase();
  const ext = fileName.toLowerCase().split('.').pop() || '';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) {
    return 'video';
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return 'image';
  }
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) {
    return 'audio';
  }
  return 'file';
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

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    return localStorage.getItem('litewire_notif_enabled') !== 'false';
  });
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    return localStorage.getItem('litewire_sound_enabled') !== 'false';
  });
  const [toasts, setToasts] = useState<IncomingToast[]>([]);

  // WebRTC Call State
  const [callSession, setCallSession] = useState<CallSessionState | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

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
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const soundEnabledRef = useRef(soundEnabled);

  // WebRTC Refs
  const callSessionRef = useRef<CallSessionState | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const incomingOfferRef = useRef<{
    callId: string;
    convoId: string;
    callType: CallType;
    sdp: RTCSessionDescriptionInit;
  } | null>(null);
  const stopRingtoneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    activeConvoRef.current = activeConvoId;
  }, [activeConvoId]);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
    localStorage.setItem('litewire_notif_enabled', String(notificationsEnabled));
  }, [notificationsEnabled]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    localStorage.setItem('litewire_sound_enabled', String(soundEnabled));
  }, [soundEnabled]);

  useEffect(() => {
    callSessionRef.current = callSession;
  }, [callSession]);

  // Update browser tab title with total unread count
  useEffect(() => {
    const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
    document.title =
      totalUnread > 0
        ? `(${totalUnread}) LiteWire — Lightweight Encrypted Messaging`
        : 'LiteWire — Lightweight Encrypted Messaging';
  }, [conversations]);

  // Unlock Web Audio on first user interaction so incoming sounds work cleanly
  useEffect(() => {
    const onInteract = () => unlockAudio();
    window.addEventListener('pointerdown', onInteract, { passive: true });
    window.addEventListener('keydown', onInteract, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
  }, []);

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

  const pushToast = useCallback(
    (toast: Omit<IncomingToast, 'id' | 'ts'>) => {
      const id = crypto.randomUUID();
      const item: IncomingToast = { ...toast, id, ts: Date.now() };
      setToasts((prev) => [...prev.slice(-3), item]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    []
  );

  const notifyIncomingMessage = useCallback(
    (convoId: string, previewText: string, senderUser?: UserProfile) => {
      if (soundEnabledRef.current) {
        playMessageArriveSound();
      }

      if (!notificationsEnabledRef.current) return;

      const senderName = senderUser?.displayName || 'New Message';
      const senderUsername = senderUser?.username || 'litewire';

      pushToast({
        convoId,
        senderName,
        senderUsername,
        preview: previewText,
      });

      if ('Notification' in window && Notification.permission === 'granted') {
        if (document.hidden || activeConvoRef.current !== convoId) {
          try {
            const notif = new Notification(`${senderName} (@${senderUsername})`, {
              body: previewText,
              icon: '/icon.svg',
            });
            notif.onclick = () => {
              window.focus();
              setActiveConvoId(convoId);
              setRoute('chat');
              notif.close();
            };
          } catch {
            // ignore notification API errors in restricted contexts
          }
        }
      }
    },
    [pushToast]
  );

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

  const recordRawBytes = useCallback((direction: 'sent' | 'received', bytes: number) => {
    const uid = currentUserRef.current?.id;
    if (!uid || bytes <= 0) return;
    setTelemetry((prev) => {
      const next: DataTelemetry =
        direction === 'sent'
          ? { ...prev, bytesSentExact: prev.bytesSentExact + bytes }
          : { ...prev, bytesReceivedExact: prev.bytesReceivedExact + bytes };
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

  // --- WebRTC Cleanup & Controls ---
  const cleanupCall = useCallback((playTone = false) => {
    if (stopRingtoneRef.current) {
      stopRingtoneRef.current();
      stopRingtoneRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    if (remoteStreamRef.current) {
      for (const track of remoteStreamRef.current.getTracks()) {
        track.stop();
      }
      remoteStreamRef.current = null;
    }
    pendingIceRef.current = [];
    incomingOfferRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setCallSession(null);
    if (playTone && soundEnabledRef.current) {
      playCallEndTone();
    }
  }, []);

  const createPeerConnection = useCallback(
    (convoId: string, callId: string, callType: CallType, stream: MediaStream) => {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      const incomingMedia = new MediaStream();
      remoteStreamRef.current = incomingMedia;
      setRemoteStream(incomingMedia);

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          for (const t of event.streams[0].getTracks()) {
            incomingMedia.addTrack(t);
          }
          setRemoteStream(new MediaStream(incomingMedia.getTracks()));
        } else if (event.track) {
          incomingMedia.addTrack(event.track);
          setRemoteStream(new MediaStream(incomingMedia.getTracks()));
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              t: 'call:ice',
              c: convoId,
              callId,
              callType,
              candidate: event.candidate.toJSON(),
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          if (stopRingtoneRef.current) {
            stopRingtoneRef.current();
            stopRingtoneRef.current = null;
          }
          setCallSession((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'connected',
                  startedAt: prev.startedAt || Date.now(),
                  error: null,
                }
              : null
          );
        } else if (state === 'failed' || state === 'closed') {
          cleanupCall(true);
        }
      };

      return pc;
    },
    [cleanupCall]
  );

  const handleStartCall = useCallback(
    async (convoId: string, peer: UserProfile, callType: CallType) => {
      if (callSessionRef.current) return;
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const callId = crypto.randomUUID();
      setCallSession({
        callId,
        convoId,
        peer,
        callType,
        direction: 'outgoing',
        status: 'calling',
        startedAt: null,
        muted: false,
        cameraOff: callType === 'audio',
        error: null,
      });

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera/Microphone access requires HTTPS or localhost.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: callType === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        });
        localStreamRef.current = stream;
        setLocalStream(stream);

        const pc = createPeerConnection(convoId, callId, callType, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        wsRef.current.send(
          JSON.stringify({
            t: 'call:offer',
            c: convoId,
            callId,
            callType,
            sdp: offer,
          })
        );

        if (soundEnabledRef.current) {
          stopRingtoneRef.current = startRingtoneLoop('outgoing');
        }
      } catch (err) {
        cleanupCall(false);
        pushToast({
          convoId,
          senderName: 'Call Failed',
          senderUsername: peer.username,
          preview:
            err instanceof Error
              ? err.message
              : 'Could not access microphone or camera permissions.',
        });
      }
    },
    [createPeerConnection, cleanupCall, pushToast]
  );

  const handleAcceptCall = useCallback(async () => {
    const session = callSessionRef.current;
    const offerInfo = incomingOfferRef.current;
    if (!session || !offerInfo || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      cleanupCall(false);
      return;
    }

    if (stopRingtoneRef.current) {
      stopRingtoneRef.current();
      stopRingtoneRef.current = null;
    }

    setCallSession((prev) => (prev ? { ...prev, status: 'connecting', error: null } : null));

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera/Microphone access requires HTTPS or localhost.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video:
          offerInfo.callType === 'video'
            ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
            : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = createPeerConnection(
        offerInfo.convoId,
        offerInfo.callId,
        offerInfo.callType,
        stream
      );

      await pc.setRemoteDescription(new RTCSessionDescription(offerInfo.sdp));

      for (const candidate of pendingIceRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      pendingIceRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      wsRef.current.send(
        JSON.stringify({
          t: 'call:answer',
          c: offerInfo.convoId,
          callId: offerInfo.callId,
          callType: offerInfo.callType,
          sdp: answer,
        })
      );

      setCallSession((prev) =>
        prev
          ? {
              ...prev,
              status: 'connected',
              startedAt: prev.startedAt || Date.now(),
            }
          : null
      );
    } catch (err) {
      wsRef.current?.send(
        JSON.stringify({
          t: 'call:reject',
          c: offerInfo.convoId,
          callId: offerInfo.callId,
          reason: 'media-error',
        })
      );
      cleanupCall(true);
      pushToast({
        convoId: offerInfo.convoId,
        senderName: 'Call Error',
        senderUsername: session.peer.username,
        preview:
          err instanceof Error
            ? err.message
            : 'Microphone or camera permission was denied.',
      });
    }
  }, [cleanupCall, createPeerConnection, pushToast]);

  const handleDeclineCall = useCallback(() => {
    const session = callSessionRef.current;
    if (session && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          t: 'call:reject',
          c: session.convoId,
          callId: session.callId,
          reason: 'declined',
        })
      );
    }
    cleanupCall(true);
  }, [cleanupCall]);

  const handleHangupCall = useCallback(() => {
    const session = callSessionRef.current;
    if (session && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          t: 'call:hangup',
          c: session.convoId,
          callId: session.callId,
        })
      );
    }
    cleanupCall(true);
  }, [cleanupCall]);

  const handleToggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setCallSession((prev) => {
      if (!prev) return null;
      const nextMuted = !prev.muted;
      for (const track of stream.getAudioTracks()) {
        track.enabled = !nextMuted;
      }
      return { ...prev, muted: nextMuted };
    });
  }, []);

  const handleToggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setCallSession((prev) => {
      if (!prev) return null;
      const nextCamOff = !prev.cameraOff;
      for (const track of stream.getVideoTracks()) {
        track.enabled = !nextCamOff;
      }
      return { ...prev, cameraOff: nextCamOff };
    });
  }, []);

  // --- Messaging & E2EE ---
  const decryptWireMessage = useCallback(
    async (wire: WireMessage, peerPublicKey?: string): Promise<DecryptedMessage> => {
      const priv = privateKeyRef.current;
      let pub = peerPublicKey;
      if (!pub) {
        const convo = conversationsRef.current.find((c) => c.id === wire.convoId);
        pub = convo?.peer.publicKey;
      }

      let rawPlaintext = '[Encrypted message]';
      if (priv && pub) {
        try {
          rawPlaintext = await decryptMessage(priv, pub, wire.convoId, wire.ct, wire.iv);
        } catch {
          rawPlaintext = '[Unable to decrypt with current device key]';
        }
      }

      const decoded = decodeMessageEnvelope(rawPlaintext);

      return {
        id: wire.id,
        cid: wire.cid,
        convoId: wire.convoId,
        seq: wire.seq,
        sid: wire.sid,
        plaintext: decoded.plaintext,
        attachment: decoded.attachment,
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
          attachment: msg.attachment || current.attachment,
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
            const rawPlain = await decryptMessage(
              privateKeyRef.current,
              c.peer.publicKey,
              c.id,
              c.lastMessage.ct,
              c.lastMessage.iv
            );
            preview = decodeMessageEnvelope(rawPlain).plaintext;
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
      conversationsRef.current = mapped;
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

  // WebSocket Connection with Exponential Backoff, Incremental Sync & WebRTC Signaling
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

        const syncFrame = JSON.stringify({ t: 's', since: lastSeqRef.current });
        ws.send(syncFrame);
        recordOutbound(syncFrame, false);

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

          let convo = conversationsRef.current.find((c) => c.id === msg.c);
          if (!convo) {
            await refreshConversations(authToken);
            convo = conversationsRef.current.find((c) => c.id === msg.c);
          }
          const peerPub = convo?.peer.publicKey;

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

          const ackFrame = JSON.stringify({ t: 'd', c: wire.convoId, id: wire.id });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(ackFrame);
            recordOutbound(ackFrame, false);
          }

          if (wire.sid !== currentUser.id) {
            notifyIncomingMessage(wire.convoId, decrypted.plaintext, convo?.peer);
          }

          if (activeConvoRef.current === wire.convoId && !document.hidden) {
            const readFrame = JSON.stringify({ t: 'r', c: wire.convoId, ids: [wire.id] });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(readFrame);
              recordOutbound(readFrame, false);
            }
          } else if (wire.sid !== currentUser.id) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === wire.convoId ? { ...c, unreadCount: c.unreadCount + 1 } : c
              )
            );
          }
        } else if (msg.t === 'a') {
          recordInbound(raw, false);
          if (msg.seq > lastSeqRef.current) {
            lastSeqRef.current = msg.seq;
            localStorage.setItem(`litewire_seq_${currentUser.id}`, String(msg.seq));
          }
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
            let lastIncoming: { convoId: string; text: string; peer?: UserProfile } | null = null;
            for (const wire of items) {
              const convo = conversationsRef.current.find((c) => c.id === wire.convoId);
              const dec = await decryptWireMessage(wire, convo?.peer.publicKey);
              upsertLocalMessage(wire.convoId, dec);
              if (wire.sid !== currentUser.id) {
                lastIncoming = { convoId: wire.convoId, text: dec.plaintext, peer: convo?.peer };
              }
            }
            if (lastIncoming) {
              notifyIncomingMessage(lastIncoming.convoId, lastIncoming.text, lastIncoming.peer);
            }
          }
        } else if (msg.t === 'call:offer') {
          const callId = String(msg.callId || '');
          const convoId = String(msg.c || '');
          const callType: CallType = msg.callType === 'video' ? 'video' : 'audio';

          if (callSessionRef.current) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ t: 'call:busy', c: convoId, callId }));
            }
            return;
          }

          let convo = conversationsRef.current.find((c) => c.id === convoId);
          if (!convo) {
            await refreshConversations(authToken);
            convo = conversationsRef.current.find((c) => c.id === convoId);
          }
          if (!convo) return;

          incomingOfferRef.current = {
            callId,
            convoId,
            callType,
            sdp: msg.sdp as RTCSessionDescriptionInit,
          };
          pendingIceRef.current = [];

          setCallSession({
            callId,
            convoId,
            peer: convo.peer,
            callType,
            direction: 'incoming',
            status: 'ringing',
            startedAt: null,
            muted: false,
            cameraOff: callType === 'audio',
            error: null,
          });

          if (soundEnabledRef.current) {
            stopRingtoneRef.current = startRingtoneLoop('incoming');
          }

          if (
            notificationsEnabledRef.current &&
            'Notification' in window &&
            Notification.permission === 'granted'
          ) {
            try {
              const n = new Notification(`${convo.peer.displayName} (@${convo.peer.username})`, {
                body: callType === 'video' ? 'Incoming video call...' : 'Incoming audio call...',
                icon: '/icon.svg',
              });
              n.onclick = () => {
                window.focus();
                n.close();
              };
            } catch {
              // ignore
            }
          }
        } else if (msg.t === 'call:answer') {
          const session = callSessionRef.current;
          const pc = pcRef.current;
          if (!session || session.callId !== msg.callId || !pc) return;

          if (stopRingtoneRef.current) {
            stopRingtoneRef.current();
            stopRingtoneRef.current = null;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          for (const c of pendingIceRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
          pendingIceRef.current = [];
          setCallSession((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'connected',
                  startedAt: prev.startedAt || Date.now(),
                }
              : null
          );
        } else if (msg.t === 'call:ice') {
          const session = callSessionRef.current;
          if (!session || session.callId !== msg.callId || !msg.candidate) return;
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
          } else {
            pendingIceRef.current.push(msg.candidate);
          }
        } else if (msg.t === 'call:reject' || msg.t === 'call:hangup') {
          const session = callSessionRef.current;
          if (!session || session.callId !== msg.callId) return;
          const peer = session.peer;
          const convoId = session.convoId;
          const wasReject = msg.t === 'call:reject';
          cleanupCall(true);
          if (wasReject) {
            pushToast({
              convoId,
              senderName: peer.displayName,
              senderUsername: peer.username,
              preview: 'Call declined',
            });
          }
        } else if (msg.t === 'call:busy' || msg.t === 'call:unavailable') {
          const session = callSessionRef.current;
          if (!session || session.callId !== msg.callId) return;
          const peer = session.peer;
          const convoId = session.convoId;
          cleanupCall(true);
          pushToast({
            convoId,
            senderName: peer.displayName,
            senderUsername: peer.username,
            preview:
              msg.t === 'call:busy'
                ? 'User is busy on another call'
                : 'User is offline — cannot connect call',
          });
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
      cleanupCall(false);
    };
  }, [
    authToken,
    currentUser,
    simulatedOffline,
    browserOnline,
    decryptWireMessage,
    upsertLocalMessage,
    refreshConversations,
    flushPendingQueue,
    recordInbound,
    recordOutbound,
    notifyIncomingMessage,
    cleanupCall,
    pushToast,
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
    cleanupCall(false);
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

  const handleSendAttachment = async (
    convoId: string,
    file: File,
    caption: string,
    onProgress: (pct: number) => void
  ) => {
    if (!currentUser || !privateKeyRef.current || !authToken) {
      throw new Error('Authentication required.');
    }
    const convo = conversations.find((c) => c.id === convoId);
    if (!convo) throw new Error('Conversation not found.');
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('File exceeds the 100 MB maximum size limit.');
    }

    onProgress(5);
    const plainBuffer = await file.arrayBuffer();
    const { encryptedBuffer, fileKeyB64, fileIvB64 } = await encryptFileBuffer(plainBuffer);
    onProgress(15);

    // Upload encrypted binary stream with progress tracking
    const uploaded = await new Promise<{ fileId: string; sizeBytes: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/files/upload?convoId=${encodeURIComponent(convoId)}`);
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
      xhr.setRequestHeader('X-Convo-Id', convoId);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.min(98, 15 + Math.round((ev.loaded / ev.total) * 83));
          onProgress(pct);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('Invalid upload response from server.'));
          }
        } else {
          try {
            const errJson = JSON.parse(xhr.responseText);
            reject(new Error(errJson.error || `Upload failed (${xhr.status})`));
          } catch {
            reject(new Error(`Upload failed (${xhr.status})`));
          }
        }
      };

      xhr.onerror = () => reject(new Error('Network error during file upload.'));
      xhr.send(encryptedBuffer);
    });

    onProgress(100);
    recordRawBytes('sent', uploaded.sizeBytes);

    // Cache sender's local blob URL for instant inline playback
    const localUrl = URL.createObjectURL(file);
    cacheDecryptedAttachmentUrl(uploaded.fileId, localUrl);

    const kind = detectAttachmentKind(file.type, file.name);
    const attachment: AttachmentPayload = {
      fileId: uploaded.fileId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      kind,
      fileKeyB64,
      fileIvB64,
      caption: caption || undefined,
    };

    const envelopeText = encodeAttachmentEnvelope(attachment);
    const decoded = decodeMessageEnvelope(envelopeText);

    const cid = crypto.randomUUID();
    const ts = Date.now();
    const { ct, iv } = await encryptMessage(
      privateKeyRef.current,
      convo.peer.publicKey,
      convoId,
      envelopeText
    );

    upsertLocalMessage(convoId, {
      id: cid,
      cid,
      convoId,
      seq: 0,
      sid: currentUser.id,
      plaintext: decoded.plaintext,
      attachment,
      ts,
      st: 'pending',
    });

    const queueItem: PendingQueueItem = {
      cid,
      convoId,
      ct,
      iv,
      plaintext: decoded.plaintext,
      ts,
    };
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
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      return;
    }
    setNotificationsEnabled(true);
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission().catch(() => {});
    }
  };

  const handleToggleSound = () => {
    unlockAudio();
    setSoundEnabled((prev) => {
      const next = !prev;
      if (next) playMessageArriveSound();
      return next;
    });
  };

  const handleTestNotification = async () => {
    unlockAudio();
    if (soundEnabledRef.current) {
      playMessageArriveSound();
    }
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission().catch(() => {});
    }
    pushToast({
      convoId: activeConvoId || '',
      senderName: currentUser?.displayName || 'LiteWire',
      senderUsername: currentUser?.username || 'system',
      preview: 'Incoming message notification & arrival chime active',
    });
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('LiteWire Test Alert', {
          body: 'Message notifications and sound effects are working.',
          icon: '/icon.svg',
        });
      } catch {
        // ignore
      }
    }
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
      {/* Incoming Message Toast Notifications */}
      {toasts.length > 0 && (
        <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="pointer-events-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-3.5 shadow-xl flex items-start gap-3"
            >
              <div className="w-8 h-8 rounded-xl bg-teal-600/15 text-teal-700 dark:text-teal-400 flex items-center justify-center shrink-0 mt-0.5">
                <Bell className="w-4 h-4" />
              </div>
              <button
                type="button"
                onClick={() => {
                  if (toast.convoId) {
                    handleSelectConversation(toast.convoId);
                    setRoute('chat');
                    setWorkspaceTab('messenger');
                  }
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id));
                }}
                className="flex-1 text-left min-w-0"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {toast.senderName}
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    @{toast.senderUsername}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 truncate mt-0.5">
                  {toast.preview}
                </p>
              </button>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="Dismiss notification"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* WebRTC Audio / Video Call Modal */}
      {callSession && (
        <CallModal
          call={callSession}
          localStream={localStream}
          remoteStream={remoteStream}
          onAccept={handleAcceptCall}
          onDecline={handleDeclineCall}
          onHangup={handleHangupCall}
          onToggleMute={handleToggleMute}
          onToggleCamera={handleToggleCamera}
        />
      )}

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
          onSendAttachment={handleSendAttachment}
          onDeleteMessageLocally={handleDeleteMessageLocally}
          onClearHistoryLocally={handleClearHistoryLocally}
          onStartChatWithUser={handleStartChatWithUser}
          onStartCall={handleStartCall}
          callActive={callSession !== null}
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
          onAttachmentBytesReceived={(bytes) => recordRawBytes('received', bytes)}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          soundEnabled={soundEnabled}
          onToggleSound={handleToggleSound}
          onTestNotification={handleTestNotification}
          onLogout={handleLogout}
          authToken={authToken || ''}
        />
      )}
    </div>
  );
}
