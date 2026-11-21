import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'litewire-store.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB maximum file/video size
const ANDROID_DIR = path.join(__dirname, 'android-project');

interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  publicKey: string;
  lastSeen: number;
  createdAt: number;
}

interface SessionRecord {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

interface MessageRecord {
  id: string;
  cid: string; // clientMsgId for idempotency
  convoId: string;
  seq: number;
  sid: string; // senderId
  ct: string; // AES-256-GCM ciphertext (base64)
  iv: string; // 96-bit IV (base64)
  ts: number;
  st: 'sent' | 'delivered' | 'read';
}

interface ConversationRecord {
  id: string;
  participants: [string, string];
  updatedAt: number;
}

interface FileRecord {
  id: string;
  convoId: string;
  uploaderId: string;
  sizeBytes: number;
  createdAt: number;
}

interface StoreState {
  globalSeq: number;
  users: Record<string, UserRecord>;
  usernameIndex: Record<string, string>;
  sessions: Record<string, SessionRecord>;
  conversations: Record<string, ConversationRecord>;
  messages: Record<string, MessageRecord[]>;
  files: Record<string, FileRecord>;
}

const DEFAULT_STORE: StoreState = {
  globalSeq: 0,
  users: {},
  usernameIndex: {},
  sessions: {},
  conversations: {},
  messages: {},
  files: {},
};

function loadStore(): StoreState {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as StoreState;
      return {
        globalSeq: parsed.globalSeq || 0,
        users: parsed.users || {},
        usernameIndex: parsed.usernameIndex || {},
        sessions: parsed.sessions || {},
        conversations: parsed.conversations || {},
        messages: parsed.messages || {},
        files: parsed.files || {},
      };
    }
  } catch (err) {
    console.error('Failed to load store, starting fresh:', err);
  }
  return structuredClone(DEFAULT_STORE);
}

let store: StoreState = loadStore();
let saveScheduled = false;

function persistStore() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_PATH);
    } catch (err) {
      console.error('Failed to persist store:', err);
    }
  }, 50);
}

// --- Password Hashing (scrypt + constant-time verify) ---
function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, s, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash: derived, salt: s };
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- Rate Limiting & Brute-Force Protection ---
interface AttemptTracker {
  count: number;
  resetAt: number;
  lockedUntil: number;
}
const authAttempts = new Map<string, AttemptTracker>();

function checkBruteForce(key: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry) return { allowed: true, retryAfterSec: 0 };
  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (entry.resetAt < now) {
    authAttempts.delete(key);
    return { allowed: true, retryAfterSec: 0 };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordFailedAttempt(key: string) {
  const now = Date.now();
  const entry = authAttempts.get(key) || { count: 0, resetAt: now + 5 * 60_000, lockedUntil: 0 };
  if (entry.resetAt < now) {
    entry.count = 1;
    entry.resetAt = now + 5 * 60_000;
    entry.lockedUntil = 0;
  } else {
    entry.count += 1;
    if (entry.count >= 5) {
      entry.lockedUntil = now + 5 * 60_000; // 5-minute progressive lockout
    }
  }
  authAttempts.set(key, entry);
}

function clearFailedAttempts(key: string) {
  authAttempts.delete(key);
}

// --- Validation ---
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

function sanitizePublicUser(u: UserRecord, onlineSet: Set<string>) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    publicKey: u.publicKey,
    online: onlineSet.has(u.id),
    lastSeen: u.lastSeen,
  };
}

// --- Active WebSocket Registry ---
const userSockets = new Map<string, Set<WebSocket>>();

function isUserOnline(userId: string): boolean {
  const sockets = userSockets.get(userId);
  return Boolean(sockets && sockets.size > 0);
}

function getOnlineSet(): Set<string> {
  const set = new Set<string>();
  for (const [uid, sockets] of userSockets.entries()) {
    if (sockets.size > 0) set.add(uid);
  }
  return set;
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendToUser(userId: string, payload: unknown) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const raw = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

function broadcastPresence(userId: string, online: boolean) {
  const user = store.users[userId];
  if (!user) return;
  user.lastSeen = Date.now();
  persistStore();

  const notified = new Set<string>();
  for (const convo of Object.values(store.conversations)) {
    if (convo.participants.includes(userId)) {
      const peerId = convo.participants.find((id) => id !== userId);
      if (peerId && !notified.has(peerId)) {
        notified.add(peerId);
        sendToUser(peerId, { t: 'p', u: userId, o: online, ls: user.lastSeen });
      }
    }
  }
}

// --- Express App ---
const app = express();
// Behind a proxy (Cloud Run, etc.) req.ip would otherwise be the proxy for every user.
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

interface AuthedRequest extends Request {
  userId?: string;
  sessionToken?: string;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const session = store.sessions[token];
  if (!session || session.expiresAt < Date.now() || !store.users[session.userId]) {
    if (session) delete store.sessions[token];
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  req.userId = session.userId;
  req.sessionToken = token;
  next();
}

// Register
app.post('/api/auth/register', (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  const rate = checkBruteForce(`reg:${ip}`);
  if (!rate.allowed) {
    res.status(429).json({ error: `Too many attempts. Retry in ${rate.retryAfterSec}s.` });
    return;
  }

  const username = String(req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
  const displayName = String(req.body?.displayName || username).trim().slice(0, 40);
  const password = String(req.body?.password || '');
  const publicKey = String(req.body?.publicKey || '');

  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: 'Username must be 3-24 characters (a-z, 0-9, underscore).' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }
  if (!publicKey || publicKey.length > 512) {
    res.status(400).json({ error: 'Valid client ECDH public key is required.' });
    return;
  }
  if (store.usernameIndex[username]) {
    recordFailedAttempt(`reg:${ip}`);
    res.status(409).json({ error: `Username @${username} is already taken.` });
    return;
  }

  const userId = crypto.randomUUID();
  const { hash, salt } = hashPassword(password);
  const now = Date.now();

  const user: UserRecord = {
    id: userId,
    username,
    displayName: displayName || username,
    passwordHash: hash,
    passwordSalt: salt,
    publicKey,
    lastSeen: now,
    createdAt: now,
  };

  store.users[userId] = user;
  store.usernameIndex[username] = userId;

  const token = crypto.randomBytes(32).toString('base64url');
  store.sessions[token] = {
    token,
    userId,
    createdAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  };
  persistStore();

  res.status(201).json({
    token,
    user: sanitizePublicUser(user, getOnlineSet()),
  });
});

// Login
app.post('/api/auth/login', (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  const username = String(req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(req.body?.password || '');
  const publicKey = req.body?.publicKey ? String(req.body.publicKey) : '';

  const rateKey = `login:${ip}:${username}`;
  const rate = checkBruteForce(rateKey);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({ error: `Account temporarily locked due to failed logins. Try again in ${rate.retryAfterSec}s.` });
    return;
  }

  const userId = store.usernameIndex[username];
  const user = userId ? store.users[userId] : undefined;
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    recordFailedAttempt(rateKey);
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  clearFailedAttempts(rateKey);
  if (publicKey && publicKey.length <= 512) {
    user.publicKey = publicKey;
  }
  const now = Date.now();
  user.lastSeen = now;

  const token = crypto.randomBytes(32).toString('base64url');
  store.sessions[token] = {
    token,
    userId: user.id,
    createdAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  };
  persistStore();

  res.json({
    token,
    user: sanitizePublicUser(user, getOnlineSet()),
  });
});

// Logout
app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res: Response) => {
  if (req.sessionToken) {
    delete store.sessions[req.sessionToken];
    persistStore();
  }
  res.json({ ok: true });
});

// Current User
app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
  const user = store.users[req.userId!];
  res.json({ user: sanitizePublicUser(user, getOnlineSet()) });
});

// Search users by username prefix
app.get('/api/users/search', requireAuth, (req: AuthedRequest, res: Response) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  const onlineSet = getOnlineSet();
  const matches = Object.values(store.users)
    .filter((u) => u.id !== req.userId && (q === '' || u.username.includes(q) || u.displayName.toLowerCase().includes(q)))
    .slice(0, 25)
    .map((u) => sanitizePublicUser(u, onlineSet));
  res.json({ users: matches });
});

// List authorized conversations
app.get('/api/conversations', requireAuth, (req: AuthedRequest, res: Response) => {
  const myId = req.userId!;
  const onlineSet = getOnlineSet();
  const list = Object.values(store.conversations)
    .filter((c) => c.participants.includes(myId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => {
      const peerId = c.participants.find((id) => id !== myId)!;
      const peer = store.users[peerId];
      const msgs = store.messages[c.id] || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const unreadCount = msgs.filter((m) => m.sid !== myId && m.st !== 'read').length;
      return {
        id: c.id,
        updatedAt: c.updatedAt,
        unreadCount,
        peer: peer ? sanitizePublicUser(peer, onlineSet) : null,
        lastMessage: lastMsg,
      };
    })
    .filter((c) => c.peer !== null);

  res.json({ conversations: list, globalSeq: store.globalSeq });
});

// Create or get 1-to-1 conversation
app.post('/api/conversations', requireAuth, (req: AuthedRequest, res: Response) => {
  const myId = req.userId!;
  const peerId = String(req.body?.peerId || '');
  if (!peerId || peerId === myId || !store.users[peerId]) {
    res.status(400).json({ error: 'Valid recipient user is required.' });
    return;
  }

  const sorted = [myId, peerId].sort() as [string, string];
  const convoId = `${sorted[0]}_${sorted[1]}`;
  if (!store.conversations[convoId]) {
    store.conversations[convoId] = {
      id: convoId,
      participants: sorted,
      updatedAt: Date.now(),
    };
    store.messages[convoId] = [];
    persistStore();
  }

  const onlineSet = getOnlineSet();
  res.json({
    conversation: {
      id: convoId,
      updatedAt: store.conversations[convoId].updatedAt,
      unreadCount: 0,
      peer: sanitizePublicUser(store.users[peerId], onlineSet),
      lastMessage: (store.messages[convoId] || []).slice(-1)[0] || null,
    },
  });
});

// Paginated + Incremental Message History (Strict participant authorization)
app.get('/api/conversations/:id/messages', requireAuth, (req: AuthedRequest, res: Response) => {
  const convoId = req.params.id;
  const convo = store.conversations[convoId];
  if (!convo) {
    res.status(404).json({ error: 'Conversation not found.' });
    return;
  }
  if (!convo.participants.includes(req.userId!)) {
    res.status(403).json({ error: 'Forbidden: you are not a participant of this conversation.' });
    return;
  }

  const all = store.messages[convoId] || [];
  const sinceSeq = Number(req.query.sinceSeq || 0);
  const beforeSeq = Number(req.query.beforeSeq || 0);
  const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);

  let result: MessageRecord[];
  let hasMore = false;

  if (sinceSeq > 0) {
    result = all.filter((m) => m.seq > sinceSeq);
  } else if (beforeSeq > 0) {
    const older = all.filter((m) => m.seq < beforeSeq);
    hasMore = older.length > limit;
    result = older.slice(-limit);
  } else {
    hasMore = all.length > limit;
    result = all.slice(-limit);
  }

  res.json({ messages: result, hasMore });
});

// Encrypted file / video upload (up to 100 MB maximum)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/api/files/upload', requireAuth, (req: AuthedRequest, res: Response) => {
  const convoId = String(req.headers['x-convo-id'] || req.query.convoId || '').trim();
  const convo = store.conversations[convoId];
  if (!convo || !convo.participants.includes(req.userId!)) {
    res.status(403).json({ error: 'Forbidden: you are not a participant of this conversation.' });
    return;
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE_SIZE_BYTES) {
    res.status(413).json({ error: 'File exceeds the 100 MB maximum size limit.' });
    return;
  }

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  const fileId = crypto.randomUUID();
  const baseUploadsDir = path.resolve(UPLOADS_DIR);
  const tmpPath = path.resolve(baseUploadsDir, `${fileId}.tmp`);
  const finalPath = path.resolve(baseUploadsDir, `${fileId}.enc`);

  if (!tmpPath.startsWith(baseUploadsDir + path.sep) || !finalPath.startsWith(baseUploadsDir + path.sep)) {
    res.status(400).json({ error: 'Invalid upload destination.' });
    return;
  }

  const writeStream = fs.createWriteStream(tmpPath);
  let receivedBytes = 0;
  let aborted = false;

  const cleanupTmp = () => {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
  };

  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_FILE_SIZE_BYTES) {
      aborted = true;
      req.pause();
      writeStream.destroy();
      cleanupTmp();
      if (!res.headersSent) {
        res.status(413).json({ error: 'File exceeds the 100 MB maximum size limit.' });
      }
      return;
    }
    if (!writeStream.write(chunk)) {
      req.pause();
      writeStream.once('drain', () => {
        if (!aborted) req.resume();
      });
    }
  });

  req.on('end', () => {
    if (aborted) return;
    writeStream.end(() => {
      if (receivedBytes === 0) {
        cleanupTmp();
        if (!res.headersSent) {
          res.status(400).json({ error: 'Uploaded file is empty.' });
        }
        return;
      }
      try {
        fs.renameSync(tmpPath, finalPath);
        store.files[fileId] = {
          id: fileId,
          convoId,
          uploaderId: req.userId!,
          sizeBytes: receivedBytes,
          createdAt: Date.now(),
        };
        persistStore();
        if (!res.headersSent) {
          res.status(201).json({ fileId, sizeBytes: receivedBytes });
        }
      } catch {
        cleanupTmp();
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to store encrypted attachment.' });
        }
      }
    });
  });

  req.on('error', () => {
    aborted = true;
    writeStream.destroy();
    cleanupTmp();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Upload stream interrupted.' });
    }
  });

  req.on('aborted', () => {
    aborted = true;
    writeStream.destroy();
    cleanupTmp();
  });

  writeStream.on('error', () => {
    aborted = true;
    cleanupTmp();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to write encrypted attachment.' });
    }
  });
});

// Download encrypted file / video (strictly participant-authorized)
app.get('/api/files/:fileId', requireAuth, (req: AuthedRequest, res: Response) => {
  const fileId = String(req.params.fileId || '').trim();
  if (!UUID_RE.test(fileId)) {
    res.status(400).json({ error: 'Invalid attachment identifier.' });
    return;
  }

  const record = store.files[fileId];
  if (!record) {
    res.status(404).json({ error: 'Attachment not found.' });
    return;
  }

  const convo = store.conversations[record.convoId];
  if (!convo || !convo.participants.includes(req.userId!)) {
    res.status(403).json({ error: 'Forbidden: you are not a participant of this conversation.' });
    return;
  }

  const baseUploadsDir = path.resolve(UPLOADS_DIR);
  const filePath = path.resolve(baseUploadsDir, `${fileId}.enc`);
  if (!filePath.startsWith(baseUploadsDir + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Encrypted attachment file is unavailable.' });
    return;
  }

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');

  const readStream = fs.createReadStream(filePath);
  readStream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
  });
  readStream.pipe(res);
});

// Android project source explorer API (reads directly from /android-project on disk)
function walkAndroidDir(dir: string, base: string): Array<{ path: string; content: string; sizeBytes: number }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ path: string; content: string; sizeBytes: number }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build' || entry.name === '.gradle' || entry.name === '.idea') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push(...walkAndroidDir(full, base));
    } else {
      const content = fs.readFileSync(full, 'utf8');
      out.push({ path: rel, content, sizeBytes: Buffer.byteLength(content, 'utf8') });
    }
  }
  return out;
}

app.get('/api/android-files', (_req: Request, res: Response) => {
  const files = walkAndroidDir(ANDROID_DIR, ANDROID_DIR).sort((a, b) => a.path.localeCompare(b.path));
  res.json({ files });
});

// --- HTTP + WebSocket Server ---
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 128 * 1024 });

// Heartbeat: drop dead mobile connections so users don't show online forever.
const aliveSockets = new WeakSet<WebSocket>();
wss.on('connection', (ws) => {
  aliveSockets.add(ws);
  ws.on('pong', () => aliveSockets.add(ws));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!aliveSockets.has(ws)) {
      ws.terminate();
      continue;
    }
    aliveSockets.delete(ws);
    ws.ping();
  }
}, 30_000);

// Remove expired sessions hourly.
setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [token, session] of Object.entries(store.sessions)) {
    if (session.expiresAt < now) {
      delete store.sessions[token];
      removed = true;
    }
  }
  if (removed) persistStore();
}, 60 * 60 * 1000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/ws', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token') || '';
  const session = store.sessions[token];

  if (!session || session.expiresAt < Date.now() || !store.users[session.userId]) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const userId = session.userId;
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId)!.add(ws);

  broadcastPresence(userId, true);
  sendJson(ws, { t: 'ready', u: userId, seq: store.globalSeq });

  ws.on('message', (rawBuf) => {
    try {
      const msg = JSON.parse(rawBuf.toString('utf8'));

      // Send encrypted message (idempotent on clientMsgId `cid`)
      if (msg.t === 'm') {
        const convoId = String(msg.c || '');
        const cid = String(msg.cid || '');
        const ct = String(msg.ct || '');
        const iv = String(msg.iv || '');

        const convo = store.conversations[convoId];
        if (!convo || !convo.participants.includes(userId)) {
          sendJson(ws, { t: 'err', code: 403, msg: 'Unauthorized conversation' });
          return;
        }
        if (!cid || !ct || !iv || ct.length > 16384) {
          sendJson(ws, { t: 'err', code: 400, msg: 'Invalid encrypted payload' });
          return;
        }

        const list = (store.messages[convoId] ||= []);
        const existing = list.find((m) => m.cid === cid);
        if (existing) {
          // Idempotent ack for retries without duplicating message
          sendJson(ws, { t: 'a', cid: existing.cid, id: existing.id, c: convoId, seq: existing.seq, ts: existing.ts, st: existing.st });
          return;
        }

        const peerId = convo.participants.find((id) => id !== userId)!;
        const peerOnline = isUserOnline(peerId);
        const seq = ++store.globalSeq;
        const ts = Date.now();
        const record: MessageRecord = {
          id: crypto.randomUUID(),
          cid,
          convoId,
          seq,
          sid: userId,
          ct,
          iv,
          ts,
          st: peerOnline ? 'delivered' : 'sent',
        };
        list.push(record);
        convo.updatedAt = ts;
        persistStore();

        // Compact ack to sender (plus other tabs of sender)
        sendToUser(userId, {
          t: 'a',
          cid: record.cid,
          id: record.id,
          c: convoId,
          seq: record.seq,
          ts: record.ts,
          st: record.st,
          ct: record.ct,
          iv: record.iv,
          sid: record.sid,
        });

        // Relay ciphertext to recipient in real time
        if (peerOnline) {
          sendToUser(peerId, {
            t: 'm',
            id: record.id,
            cid: record.cid,
            c: convoId,
            seq: record.seq,
            sid: record.sid,
            ct: record.ct,
            iv: record.iv,
            ts: record.ts,
            st: record.st,
          });
        }
      }

      // Delivered acknowledgment from recipient
      if (msg.t === 'd') {
        const convoId = String(msg.c || '');
        const msgId = String(msg.id || '');
        const convo = store.conversations[convoId];
        if (!convo || !convo.participants.includes(userId)) return;
        const item = (store.messages[convoId] || []).find((m) => m.id === msgId);
        if (item && item.sid !== userId && item.st === 'sent') {
          item.st = 'delivered';
          persistStore();
          sendToUser(item.sid, { t: 'st', c: convoId, id: item.id, st: 'delivered' });
        }
      }

      // Read receipt batch
      if (msg.t === 'r') {
        const convoId = String(msg.c || '');
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        const convo = store.conversations[convoId];
        if (!convo || !convo.participants.includes(userId)) return;
        const list = store.messages[convoId] || [];
        let changed = false;
        for (const item of list) {
          if (ids.includes(item.id) && item.sid !== userId && item.st !== 'read') {
            item.st = 'read';
            changed = true;
            sendToUser(item.sid, { t: 'st', c: convoId, id: item.id, st: 'read' });
          }
        }
        if (changed) persistStore();
      }

      // Incremental synchronization delta since `since` globalSeq
      if (msg.t === 's') {
        const since = Number(msg.since || 0);
        const delta: MessageRecord[] = [];
        for (const convo of Object.values(store.conversations)) {
          if (!convo.participants.includes(userId)) continue;
          const msgs = store.messages[convo.id] || [];
          for (const m of msgs) {
            if (m.seq > since) {
              if (m.sid !== userId && m.st === 'sent') {
                m.st = 'delivered';
                sendToUser(m.sid, { t: 'st', c: convo.id, id: m.id, st: 'delivered' });
              }
              delta.push(m);
            }
          }
        }
        delta.sort((a, b) => a.seq - b.seq);
        if (delta.length > 0) persistStore();
        sendJson(ws, { t: 'delta', msgs: delta, seq: store.globalSeq });
      }

      // WebRTC Audio/Video Call Signaling Relay (strict participant authorization)
      if (
        msg.t === 'call:offer' ||
        msg.t === 'call:answer' ||
        msg.t === 'call:ice' ||
        msg.t === 'call:reject' ||
        msg.t === 'call:hangup' ||
        msg.t === 'call:busy'
      ) {
        const convoId = String(msg.c || '');
        const callId = String(msg.callId || '');
        const convo = store.conversations[convoId];
        if (!convo || !convo.participants.includes(userId) || !callId) {
          return;
        }
        const peerId = convo.participants.find((id) => id !== userId);
        if (!peerId) return;

        if (msg.t === 'call:offer' && !isUserOnline(peerId)) {
          sendJson(ws, {
            t: 'call:unavailable',
            c: convoId,
            callId,
            reason: 'offline',
          });
          return;
        }

        sendToUser(peerId, {
          t: msg.t,
          c: convoId,
          callId,
          from: userId,
          callType: msg.callType === 'video' ? 'video' : 'audio',
          sdp: msg.sdp,
          candidate: msg.candidate,
          reason: msg.reason ? String(msg.reason) : undefined,
        });
      }
    } catch {
      // Ignore malformed JSON frames cleanly
    }
  });

  ws.on('close', () => {
    const set = userSockets.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        userSockets.delete(userId);
        broadcastPresence(userId, false);
      }
    }
  });
});

// Save immediately when the host stops the process so no messages are lost on restart.
function flushStoreSync() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('Failed to flush store on shutdown:', err);
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    flushStoreSync();
    process.exit(0);
  });
}

// Mount Vite in dev or static dist in production
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`LiteWire server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
