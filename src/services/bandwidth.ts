import { DataTelemetry } from '../types/messaging';

const encoder = new TextEncoder();
const ESTIMATED_FRAME_OVERHEAD_BYTES = 64; // TCP/TLS + WebSocket frame header estimate

export function measureUtf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

export function loadTelemetry(userId: string): DataTelemetry {
  try {
    const raw = localStorage.getItem(`litewire_telemetry_${userId}`);
    if (raw) return JSON.parse(raw) as DataTelemetry;
  } catch {
    // ignore
  }
  return {
    bytesSentExact: 0,
    bytesReceivedExact: 0,
    estimatedOverheadBytes: 0,
    messagesSent: 0,
    messagesReceived: 0,
  };
}

export function saveTelemetry(userId: string, telemetry: DataTelemetry): void {
  localStorage.setItem(`litewire_telemetry_${userId}`, JSON.stringify(telemetry));
}

export function addOutboundTelemetry(
  prev: DataTelemetry,
  payloadString: string,
  isChatMessage: boolean
): DataTelemetry {
  return {
    ...prev,
    bytesSentExact: prev.bytesSentExact + measureUtf8Bytes(payloadString),
    estimatedOverheadBytes: prev.estimatedOverheadBytes + ESTIMATED_FRAME_OVERHEAD_BYTES,
    messagesSent: prev.messagesSent + (isChatMessage ? 1 : 0),
  };
}

export function addInboundTelemetry(
  prev: DataTelemetry,
  payloadString: string,
  isChatMessage: boolean
): DataTelemetry {
  return {
    ...prev,
    bytesReceivedExact: prev.bytesReceivedExact + measureUtf8Bytes(payloadString),
    estimatedOverheadBytes: prev.estimatedOverheadBytes + ESTIMATED_FRAME_OVERHEAD_BYTES,
    messagesReceived: prev.messagesReceived + (isChatMessage ? 1 : 0),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
