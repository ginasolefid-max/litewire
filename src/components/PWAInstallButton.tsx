import { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'primary' | 'secondary';
}

export default function PWAInstallButton({ variant = 'secondary' }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  async function handleClick() {
    if (isInstallable) {
      const ok = await install();
      if (ok) return;
    }
    setShowGuide(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={
          variant === 'primary'
            ? 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold transition-colors whitespace-nowrap'
            : 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap'
        }
      >
        {isInstallable ? <Download className="w-3.5 h-3.5" /> : <Smartphone className="w-3.5 h-3.5" />}
        <span>{isInstallable ? 'Install App on Phone' : 'Install on Phone (No APK)'}</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4 text-left shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-teal-600 dark:text-teal-400" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Install LiteWire on Your Phone
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              If your phone says <strong className="text-slate-900 dark:text-slate-200">&ldquo;Blocked by your IT admin&rdquo;</strong> when installing an <code className="font-mono">.apk</code> file, your work/school account or device management policy blocks APK sideloading. Install the Progressive Web App directly from your browser instead — no APK needed:
            </p>

            {isIOS ? (
              <ol className="space-y-2 text-xs text-slate-700 dark:text-slate-300 list-decimal pl-4 leading-relaxed">
                <li>Open this page in <strong>Safari</strong> on your iPhone or iPad.</li>
                <li>Tap the <strong>Share</strong> icon in the bottom toolbar.</li>
                <li>Scroll down and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
              </ol>
            ) : (
              <ol className="space-y-2 text-xs text-slate-700 dark:text-slate-300 list-decimal pl-4 leading-relaxed">
                <li>Open the LiteWire URL in <strong>Chrome</strong> (or Edge) on your Android phone.</li>
                <li>Tap the <strong>⋮</strong> menu in the top-right corner of Chrome.</li>
                <li>Tap <strong>Add to Home screen</strong> → <strong>Install</strong>.</li>
              </ol>
            )}

            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              Includes full E2EE messaging, arrival sound effects, notifications, audio/video calls, and 100 MB encrypted file &amp; video sharing.
            </p>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
