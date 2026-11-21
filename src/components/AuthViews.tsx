import { FormEvent, useState } from 'react';
import { Lock, Shield, ArrowRight, AlertCircle } from 'lucide-react';
import { ScreenRoute } from '../types/messaging';
import PWAInstallButton from './PWAInstallButton';

interface AuthViewsProps {
  route: 'splash' | 'login' | 'register';
  loading: boolean;
  error: string | null;
  onNavigate: (route: ScreenRoute) => void;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, displayName: string, password: string) => Promise<void>;
}

export default function AuthViews({
  route,
  loading,
  error,
  onNavigate,
  onLogin,
  onRegister,
}: AuthViewsProps) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  if (route === 'splash') {
    return (
      <div className="min-h-[calc(100vh-57px)] flex items-center justify-center px-4 py-12 bg-slate-50 dark:bg-slate-950">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-teal-600/10 dark:bg-teal-500/15 border border-teal-600/20 flex items-center justify-center">
            <Lock className="w-7 h-7 text-teal-600 dark:text-teal-400" />
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
              LiteWire Encrypted Messenger
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Ultra-low-data real-time messaging built for Wi-Fi and ordinary mobile SIM internet. End-to-end encrypted with ECDH P-256 and AES-256-GCM.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <button
              onClick={() => onNavigate('login')}
              className="px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <span>Sign In</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => onNavigate('register')}
              className="px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-semibold transition-colors whitespace-nowrap"
            >
              Create Account
            </button>
          </div>
          <div className="flex justify-center">
            <PWAInstallButton variant="secondary" />
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed pt-2">
            No SMS credits or promo bundle required. Standard carrier pay-per-use data charges may apply on cellular networks without an active data plan.
          </p>
        </div>
      </div>
    );
  }

  const isRegister = route === 'register';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isRegister) {
      await onRegister(username, displayName, password);
    } else {
      await onLogin(username, password);
    }
  }

  return (
    <div className="min-h-[calc(100vh-57px)] flex items-center justify-center px-4 py-10 bg-slate-50 dark:bg-slate-950">
      <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-teal-700 dark:text-teal-400">
            <Shield className="w-4 h-4" />
            <span>Client-Side ECDH P-256 Key Generation</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {isRegister ? 'Create Encrypted Account' : 'Sign In to LiteWire'}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {isRegister
              ? 'Your private encryption key stays strictly in this browser. Passwords are hashed server-side with scrypt.'
              : 'Reconnect with your unique @username to sync only missing delta messages.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="auth-username" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Username
            </label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="e.g. maya_lin"
              required
              minLength={3}
              maxLength={24}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          {isRegister && (
            <div className="space-y-1.5">
              <label htmlFor="auth-display" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Display Name
              </label>
              <input
                id="auth-display"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Maya Lin"
                maxLength={40}
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Password (minimum 8 characters)
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {loading ? 'Processing...' : isRegister ? 'Register & Generate Keys' : 'Sign In'}
          </button>
        </form>

        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => onNavigate(isRegister ? 'login' : 'register')}
            className="text-teal-700 dark:text-teal-400 hover:underline font-medium"
          >
            {isRegister ? 'Already registered? Sign in' : 'Need an account? Register'}
          </button>
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:underline"
          >
            Open 2nd User Tab
          </a>
        </div>
      </div>
    </div>
  );
}
