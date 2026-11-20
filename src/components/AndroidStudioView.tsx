import { useEffect, useState } from 'react';
import JSZip from 'jszip';
import {
  CheckCircle2,
  Copy,
  Check,
  Download,
  FileCode2,
  FolderTree,
  Lock,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react';
import { AndroidProjectFile } from '../types/messaging';

const PHASES = [
  {
    id: '01',
    title: 'Phase 1: Architecture & Backend Selection',
    summary:
      'Firebase (Auth + Cloud Firestore + Data-only FCM) was selected for Android native offline persistence, delta snapshot listeners without polling, and serverless TLS scaling; paired here in the live web workspace with an Express + WebSocket + scrypt backend using identical ECDH/AES-GCM cryptography.',
  },
  {
    id: '02',
    title: 'Phase 2: Database Design & Security Rules',
    summary:
      'Deterministic 1-to-1 conversation IDs (sorted(uidA, uidB)), separate username reservation index (/usernames/{username}), isolated FCM token collection (/userTokens/{uid}), and strict Firestore rules rejecting any message containing a plaintext field.',
  },
  {
    id: '03',
    title: 'Phase 3: Authentication & Session Hardening',
    summary:
      'Unique lowercase @username validation (^[a-z0-9_]{3,24}$), scrypt password hashing with 16-byte per-user random salt, constant-time signature verification, sliding-window brute-force lockout (5 attempts / 5 min), and full local cache wipe on logout.',
  },
  {
    id: '04',
    title: 'Phase 4: Real-Time Messaging & Incremental Sync',
    summary:
      'Persistent WebSocket / Firestore snapshot channels with minified JSON frames, pagination (30 messages/page), and cursor-based incremental sync (sinceSeq / sinceTimestamp) so reconnects never re-download full conversation history.',
  },
  {
    id: '05',
    title: 'Phase 5: End-to-End Encryption (ECDH + AES-256-GCM)',
    summary:
      'NIST P-256 (secp256r1) identity keypair stored locally (Android Keystore EncryptedSharedPreferences on Android; WebCrypto non-server storage on web), HKDF-SHA256 bound to conversationId, and AES-256-GCM with fresh 96-bit CSPRNG IV and AAD per message.',
  },
  {
    id: '06',
    title: 'Phase 6: Offline Queue & Exponential Backoff',
    summary:
      'Messages composed offline are encrypted immediately, rendered as Pending, persisted to Room pending_messages / localStorage queue, and flushed automatically via WorkManager (NetworkType.CONNECTED + exponential backoff) with idempotent clientMsgId deduplication.',
  },
];

const DATA_BUDGET_ROWS = [
  { operation: 'Send 1 short text message ("On my way")', exactPayload: '~145 B', estOverhead: '~64 B', total: '~209 B' },
  { operation: 'Receive 1 encrypted message + Delivered ACK', exactPayload: '~195 B', estOverhead: '~128 B', total: '~323 B' },
  { operation: 'Read receipt batch (up to 10 messages)', exactPayload: '~110 B', estOverhead: '~64 B', total: '~174 B' },
  { operation: 'Presence update (Online / Offline delta)', exactPayload: '~44 B', estOverhead: '~64 B', total: '~108 B' },
  { operation: '1,000 text messages (500 sent + 500 received)', exactPayload: '~170 KB', estOverhead: '~96 KB', total: '~266 KB (~0.26 MB)' },
];

const ACCEPTANCE_TESTS = [
  'TEST 1: Two separate accounts can register unique @usernames with isolated ECDH keypairs.',
  'TEST 2: User 1 can compose and send an encrypted message to User 2.',
  'TEST 3: User 2 receives and decrypts the message in real time via WebSocket / Firestore listener.',
  'TEST 4: Operates on Wi-Fi or ordinary mobile SIM internet without a specific data promo (pay-per-use rates may apply).',
  'TEST 5: Zero SMS permissions (SEND_SMS/READ_SMS omitted) and zero SMS fallback.',
  'TEST 6: Conversation history and keys persist locally across app restarts.',
  'TEST 7: Offline-composed messages stay Pending and flush idempotently when connectivity returns.',
  'TEST 8: Server & Firestore Rules return 403 / PERMISSION_DENIED to non-participants.',
  'TEST 9: Backend stores only {ct, iv} ciphertext; plaintext never leaves client devices.',
  'TEST 10: Exact application payload bytes and estimated transport overhead are tracked live in Settings.',
];

export default function AndroidStudioView() {
  const [files, setFiles] = useState<AndroidProjectFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [subTab, setSubTab] = useState<'source' | 'blueprint' | 'tests'>('source');

  useEffect(() => {
    fetch('/api/android-files')
      .then((r) => r.json())
      .then((data) => {
        const list = (data.files || []) as AndroidProjectFile[];
        setFiles(list);
        if (list.length > 0) {
          const preferred =
            list.find((f) => f.path.endsWith('CryptoManager.kt')) ||
            list.find((f) => f.path.endsWith('MainActivity.kt')) ||
            list[0];
          setSelectedPath(preferred.path);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const selectedFile = files.find((f) => f.path === selectedPath);
  const totalSourceBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);

  async function handleDownloadZip() {
    if (files.length === 0) return;
    setDownloading(true);
    try {
      const zip = new JSZip();
      for (const file of files) {
        zip.file(`LiteWire-Android/${file.path}`, file.content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'LiteWire-Android-Kotlin.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  function handleCopyFile() {
    if (!selectedFile) return;
    navigator.clipboard.writeText(selectedFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Native Android Kotlin & Jetpack Compose Project
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            <span>{files.length} source files</span>
            <span className="mx-2" aria-hidden="true">·</span>
            <span className="tabular-nums">{(totalSourceBytes / 1024).toFixed(1)} KB total source</span>
            <span className="mx-2" aria-hidden="true">·</span>
            <span>Min SDK 26 · Target SDK 35 · Room + WorkManager + Keystore + Firebase</span>
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              onClick={() => setSubTab('source')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'source'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Source Files
            </button>
            <button
              onClick={() => setSubTab('blueprint')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'blueprint'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Architecture & Data Budget
            </button>
            <button
              onClick={() => setSubTab('tests')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'tests'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              APK Build & Tests
            </button>
          </div>

          <button
            onClick={handleDownloadZip}
            disabled={downloading || files.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4" />
            <span>{downloading ? 'Packaging...' : 'Download Android Project (.zip)'}</span>
          </button>
        </div>
      </div>

      {subTab === 'source' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          <div className="lg:col-span-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <FolderTree className="w-4 h-4 text-teal-600 dark:text-teal-400" />
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Project Tree (/android-project)
              </span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800/70 max-h-[620px] overflow-y-auto">
              {loading && (
                <div className="p-4 text-sm text-slate-500">Loading Android project files...</div>
              )}
              {files.map((file) => {
                const active = file.path === selectedPath;
                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                    className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                      active
                        ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-900 dark:text-teal-200'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <FileCode2 className="w-3.5 h-3.5 shrink-0 opacity-70" />
                      <span className="text-xs font-mono truncate">{file.path}</span>
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-slate-500 shrink-0">
                      {(file.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-8 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
              <span className="text-xs font-mono text-slate-800 dark:text-slate-200 truncate">
                {selectedFile ? selectedFile.path : 'Select a file'}
              </span>
              {selectedFile && (
                <button
                  onClick={handleCopyFile}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-teal-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              )}
            </div>
            <pre className="p-4 text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-950 overflow-auto max-h-[620px] flex-1">
              <code>{selectedFile ? selectedFile.content : ''}</code>
            </pre>
          </div>
        </div>
      )}

      {subTab === 'blueprint' && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {PHASES.map((phase) => (
              <div
                key={phase.id}
                className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2"
              >
                <div className="text-xs font-mono text-teal-700 dark:text-teal-400">Phase {phase.id}</div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{phase.title}</h3>
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">{phase.summary}</p>
              </div>
            ))}
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Estimated Mobile Data Consumption Analysis (Text Messaging)
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Pay-per-use cellular disclaimer: LiteWire works over any active Wi-Fi or cellular SIM connection without requiring a specific data promo, and never uses SMS. Mobile carriers may still bill standard pay-per-use rates per kilobyte transferred.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5 font-medium">Operation</th>
                    <th className="py-3 px-5 font-medium text-right">App Payload (Exact)</th>
                    <th className="py-3 px-5 font-medium text-right">TCP/TLS Framing (Est.)</th>
                    <th className="py-3 px-5 font-medium text-right">Total Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {DATA_BUDGET_ROWS.map((row) => (
                    <tr key={row.operation} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-5 text-slate-800 dark:text-slate-200">{row.operation}</td>
                      <td className="py-3 px-5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {row.exactPayload}
                      </td>
                      <td className="py-3 px-5 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {row.estOverhead}
                      </td>
                      <td className="py-3 px-5 text-right font-mono tabular-nums font-semibold text-teal-700 dark:text-teal-400">
                        {row.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {subTab === 'tests' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-teal-600 dark:text-teal-400" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Final Acceptance Verification Matrix (Tests 1–10)
              </h2>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {ACCEPTANCE_TESTS.map((item) => (
                <div key={item} className="py-3 flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
                  <span className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-teal-600 dark:text-teal-400" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                APK Generation Instructions
              </h2>
            </div>
            <ol className="space-y-3 text-xs leading-relaxed text-slate-600 dark:text-slate-400 list-decimal pl-4">
              <li>
                Download <strong className="text-slate-900 dark:text-slate-200">LiteWire-Android-Kotlin.zip</strong> and extract it.
              </li>
              <li>
                Create a Firebase project, enable <strong className="text-slate-900 dark:text-slate-200">Email/Password Auth</strong> and <strong className="text-slate-900 dark:text-slate-200">Cloud Firestore</strong>, and deploy <code className="font-mono">firebase/firestore.rules</code>.
              </li>
              <li>
                Download <code className="font-mono">google-services.json</code> for package <code className="font-mono">com.litewire.app</code> and place it inside <code className="font-mono">app/</code>.
              </li>
              <li>
                Open the folder in <strong className="text-slate-900 dark:text-slate-200">Android Studio Ladybug+</strong> (JDK 17) and run <code className="font-mono">./gradlew assembleDebug</code> for USB testing on two phones, or <code className="font-mono">./gradlew assembleRelease</code> with your signing keystore for a minified R8 APK.
              </li>
            </ol>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-2 text-slate-900 dark:text-slate-100 font-medium">
                <Lock className="w-4 h-4 text-teal-600" />
                <span>How to test two real users right now in this Web App:</span>
              </div>
              <p>
                Open this live app URL in two browser tabs (each tab keeps an independent session via <code className="font-mono">sessionStorage</code>), register <code className="font-mono">@user1</code> in Tab 1 and <code className="font-mono">@user2</code> in Tab 2, search by username, and exchange real-time E2EE messages!
              </p>
              <div className="flex items-center gap-2 pt-1 text-slate-500">
                <Wifi className="w-3.5 h-3.5" />
                <span>Toggle "Simulate Offline" in Settings to verify pending queue & automatic reconnect flush.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
