# LiteWire Phone Setup & GitHub Build Guide

## Option 1: Install Directly on Your Phone (Works Even When IT Admin Blocks APKs)
If your phone says **"Blocked by your IT admin"** when opening an `.apk` file, your device has a Work Profile, school/company Google account, or MDM policy that blocks sideloaded APK files.

You can install LiteWire directly from your browser with **no `.apk` file needed**:
1. Open the live LiteWire web URL in **Chrome** (Android) or **Safari** (iPhone/iPad).
2. Tap **"Install App"** inside LiteWire (or in Chrome tap the `⋮` menu → **Install app** / **Add to Home screen**; on iPhone tap **Share** → **Add to Home Screen**).
3. Launch **LiteWire** from your Home Screen like a native app — includes E2EE messaging, sound effects, notifications, audio/video calls, and 100 MB encrypted file/video sharing.

---

## Option 2: Push to GitHub & Build the Native Android APK (Personal / Unmanaged Phones)

### A. Firebase Setup
1. Go to `console.firebase.google.com` → Create a project (Analytics optional/off).
2. **Build → Authentication → Get started → Email/Password → Enable**.
3. **Build → Firestore Database → Create database → Production mode**.
4. **Firestore → Rules tab** → paste `android-project/firebase/firestore.rules` → **Publish**.
5. **Project settings → Add app → Android** (`com.litewire.app`) → Download `google-services.json`.

### B. Add GitHub Secret (Keeps API Keys Out of Git)
`google-services.json` is excluded in `.gitignore` so GitHub Push Protection never blocks your `git push`.
1. Open your GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `GOOGLE_SERVICES_JSON`
3. Value: paste the full JSON contents of your `google-services.json`.

### C. Push & Download APK
1. Commit and push your repository to `main` (no API keys or `data/` files are committed).
2. Go to **GitHub → Actions → Build LiteWire APK → Run workflow**.
3. Download the `litewire-debug-apk` artifact, unzip it, and install on a personal/unmanaged Android phone (note: phones managed by an IT admin / Work Profile / Family Link block APK sideloading — use **Option 1** on managed phones).
