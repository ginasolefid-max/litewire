import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Play,
} from 'lucide-react';
import { AttachmentPayload } from '../types/messaging';
import { decryptFileBuffer } from '../crypto/e2ee';
import { formatBytes } from '../services/bandwidth';

// In-memory cache of decrypted object URLs so media stays instant across re-renders
const decryptedUrlCache = new Map<string, string>();

export function cacheDecryptedAttachmentUrl(fileId: string, url: string): void {
  decryptedUrlCache.set(fileId, url);
}

interface AttachmentBubbleProps {
  attachment: AttachmentPayload;
  authToken: string;
  isMine: boolean;
  onBytesReceived?: (bytes: number) => void;
}

export default function AttachmentBubble({
  attachment,
  authToken,
  isMine,
  onBytesReceived,
}: AttachmentBubbleProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(
    () => decryptedUrlCache.get(attachment.fileId) || null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAndDecrypt = useCallback(async (): Promise<string | null> => {
    const cached = decryptedUrlCache.get(attachment.fileId);
    if (cached) {
      setBlobUrl(cached);
      return cached;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(attachment.fileId)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'Attachment no longer on server' : 'Download failed');
      }
      const encryptedBuf = await res.arrayBuffer();
      onBytesReceived?.(encryptedBuf.byteLength);

      const plainBuf = await decryptFileBuffer(
        encryptedBuf,
        attachment.fileKeyB64,
        attachment.fileIvB64
      );
      const safeMime = attachment.mimeType || 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([plainBuf], { type: safeMime }));
      decryptedUrlCache.set(attachment.fileId, url);
      setBlobUrl(url);
      return url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to decrypt attachment');
      return null;
    } finally {
      setLoading(false);
    }
  }, [attachment, authToken, onBytesReceived]);

  // Auto-decrypt compact images (<= 8 MB) for seamless inline viewing
  useEffect(() => {
    if (
      !blobUrl &&
      attachment.kind === 'image' &&
      attachment.sizeBytes <= 8 * 1024 * 1024 &&
      authToken
    ) {
      fetchAndDecrypt();
    }
  }, [blobUrl, attachment.kind, attachment.sizeBytes, authToken, fetchAndDecrypt]);

  const handleDownload = async () => {
    const url = blobUrl || (await fetchAndDecrypt());
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.fileName.replace(/[/\\]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const Icon =
    attachment.kind === 'video'
      ? Film
      : attachment.kind === 'image'
      ? ImageIcon
      : attachment.kind === 'audio'
      ? Music
      : FileText;

  return (
    <div className="space-y-2">
      {/* Inline Media Preview once decrypted */}
      {blobUrl && attachment.kind === 'video' && (
        <video
          src={blobUrl}
          controls
          playsInline
          className="w-full max-w-sm max-h-72 rounded-xl bg-black"
        />
      )}

      {blobUrl && attachment.kind === 'image' && (
        <img
          src={blobUrl}
          alt={attachment.fileName}
          className="w-full max-w-xs max-h-72 object-contain rounded-xl bg-black/5"
        />
      )}

      {blobUrl && attachment.kind === 'audio' && (
        <audio src={blobUrl} controls className="w-full max-w-xs" />
      )}

      {/* Attachment Info & Action Bar */}
      <div
        className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${
          isMine
            ? 'bg-teal-700/60 text-white'
            : 'bg-slate-100 dark:bg-slate-800/80 text-slate-900 dark:text-slate-100'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold truncate">{attachment.fileName}</div>
            <div
              className={`text-[11px] font-mono tabular-nums ${
                isMine ? 'text-teal-100' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {formatBytes(attachment.sizeBytes)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!blobUrl && (attachment.kind === 'video' || attachment.kind === 'audio' || attachment.kind === 'image') && (
            <button
              type="button"
              onClick={fetchAndDecrypt}
              disabled={loading}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                isMine
                  ? 'bg-white text-teal-800 hover:bg-teal-50'
                  : 'bg-teal-600 text-white hover:bg-teal-700'
              }`}
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>{loading ? 'Loading' : attachment.kind === 'video' ? 'Play' : 'View'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleDownload}
            disabled={loading}
            className={`p-1.5 rounded-lg transition-colors ${
              isMine
                ? 'hover:bg-teal-600 text-white'
                : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
            }`}
            title="Decrypt & Download"
            aria-label="Decrypt and download file"
          >
            {loading && attachment.kind === 'file' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {attachment.caption && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{attachment.caption}</p>
      )}

      {error && (
        <p className={`text-[11px] ${isMine ? 'text-amber-200' : 'text-red-600 dark:text-red-400'}`}>
          {error}
        </p>
      )}
    </div>
  );
}
