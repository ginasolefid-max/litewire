import { useEffect, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { CallSessionState } from '../types/messaging';

interface CallModalProps {
  call: CallSessionState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onAccept: () => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function CallModal({
  call,
  localStream,
  remoteStream,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleCamera,
}: CallModalProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, call.callType, call.cameraOff]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, call.callType, call.status]);

  useEffect(() => {
    if (call.status !== 'connected' || !call.startedAt) {
      setElapsedSec(0);
      return;
    }
    const update = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - call.startedAt!) / 1000)));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [call.status, call.startedAt]);

  const initials = (call.peer.displayName || call.peer.username)
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');

  // Incoming ringing modal
  if (call.direction === 'incoming' && call.status === 'ringing') {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 text-center space-y-6 shadow-2xl">
          <div className="mx-auto w-20 h-20 rounded-full bg-teal-600/15 border border-teal-500/30 flex items-center justify-center text-2xl font-bold text-teal-700 dark:text-teal-300 font-display">
            {initials || '?'}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-teal-700 dark:text-teal-400">
              {call.callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call'}
            </p>
            <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {call.peer.displayName}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">@{call.peer.username}</p>
          </div>

          <div className="flex items-center justify-center gap-5 pt-2">
            <button
              onClick={onDecline}
              className="flex flex-col items-center gap-1.5 group"
              aria-label="Decline call"
            >
              <span className="w-14 h-14 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors shadow-lg">
                <PhoneOff className="w-6 h-6" />
              </span>
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Decline
              </span>
            </button>

            <button
              onClick={onAccept}
              className="flex flex-col items-center gap-1.5 group"
              aria-label="Accept call"
            >
              <span className="w-14 h-14 rounded-full bg-teal-600 hover:bg-teal-700 text-white flex items-center justify-center transition-colors shadow-lg">
                {call.callType === 'video' ? (
                  <Video className="w-6 h-6" />
                ) : (
                  <Phone className="w-6 h-6" />
                )}
              </span>
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Accept
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const statusText =
    call.status === 'calling'
      ? 'Calling...'
      : call.status === 'connecting'
      ? 'Connecting encrypted media...'
      : formatDuration(elapsedSec);

  const hasRemoteVideo =
    call.callType === 'video' &&
    remoteStream !== null &&
    remoteStream.getVideoTracks().some((t) => t.readyState === 'live');

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-0 sm:p-6">
      <div className="w-full h-full sm:h-auto sm:max-w-3xl sm:aspect-video bg-slate-900 sm:border sm:border-slate-800 sm:rounded-3xl overflow-hidden flex flex-col relative shadow-2xl">
        {/* Always mount remote audio element so audio plays in both audio-only & video calls */}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

        {/* Media Stage */}
        <div className="flex-1 relative bg-slate-950 flex items-center justify-center overflow-hidden">
          {call.callType === 'video' && hasRemoteVideo ? (
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-center p-6 space-y-4">
              <div className="w-24 h-24 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-3xl font-bold text-teal-400 font-display">
                {initials || '?'}
              </div>
              <div className="space-y-1">
                <h3 className="text-xl font-bold text-white">{call.peer.displayName}</h3>
                <p className="text-xs text-slate-400">@{call.peer.username}</p>
              </div>
              <div className="inline-flex items-center gap-2 text-xs font-mono tabular-nums text-teal-400">
                <Volume2 className="w-4 h-4" />
                <span>
                  {call.callType === 'video' ? 'Video Call' : 'Audio Call'} · {statusText}
                </span>
              </div>
            </div>
          )}

          {/* Top Info Scrim when remote video is visible */}
          {call.callType === 'video' && hasRemoteVideo && (
            <div className="absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/75 via-black/35 to-transparent flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">{call.peer.displayName}</h3>
                <p className="text-xs font-mono tabular-nums text-teal-300">
                  @{call.peer.username} · {statusText}
                </p>
              </div>
            </div>
          )}

          {/* Local Self-View PiP */}
          {call.callType === 'video' && localStream && !call.cameraOff && (
            <div className="absolute bottom-4 right-4 w-28 sm:w-36 aspect-[3/4] sm:aspect-video rounded-xl overflow-hidden border border-white/20 bg-slate-900 shadow-lg">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover -scale-x-100"
              />
            </div>
          )}

          {call.error && (
            <div className="absolute bottom-4 left-4 right-4 sm:right-auto sm:max-w-sm bg-red-950/90 border border-red-700 text-red-200 text-xs px-3.5 py-2.5 rounded-xl">
              {call.error}
            </div>
          )}
        </div>

        {/* Bottom Call Controls */}
        <div className="px-6 py-4 bg-slate-900/95 border-t border-slate-800 flex items-center justify-center gap-4">
          <button
            onClick={onToggleMute}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
              call.muted
                ? 'bg-amber-600 text-white hover:bg-amber-700'
                : 'bg-slate-800 text-slate-100 hover:bg-slate-700'
            }`}
            title={call.muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {call.muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>

          {call.callType === 'video' && (
            <button
              onClick={onToggleCamera}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                call.cameraOff
                  ? 'bg-amber-600 text-white hover:bg-amber-700'
                  : 'bg-slate-800 text-slate-100 hover:bg-slate-700'
              }`}
              title={call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
              aria-label={call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
            >
              {call.cameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
            </button>
          )}

          <button
            onClick={onHangup}
            className="w-14 h-12 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors shadow-lg"
            title="End call"
            aria-label="End call"
          >
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
