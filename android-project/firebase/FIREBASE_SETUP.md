# LiteWire Android Setup & APK Build Guide

## 1. Network & Carrier Notice (Important)
LiteWire uses standard HTTPS/TLS and Firebase persistent connections over whatever active internet interface Android provides (`NET_CAPABILITY_INTERNET`), whether Wi-Fi or an ordinary cellular SIM card.
- LiteWire does **not** bypass carrier billing, captive portals, or ISP firewalls.
- If a SIM card has no active data promo, mobile carriers may charge standard pay-per-use rates for any kilobytes transmitted.
- LiteWire **never** requests `SEND_SMS`, `READ_SMS`, or `RECEIVE_SMS` permissions and never falls back to SMS.

## 2. Firebase Project Configuration
1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a project (e.g., `litewire-prod`).
2. **Enable Authentication**:
   - Navigate to **Build → Authentication → Sign-in method**.
   - Enable **Email/Password**. (LiteWire maps unique `@username` handles internally or pairs username registration with Firebase Auth email/password + bcrypt/scrypt managed by Firebase Auth).
3. **Create Cloud Firestore**:
   - Navigate to **Build → Firestore Database → Create database** (Production mode).
   - Deploy `firebase/firestore.rules` and `firebase/firestore.indexes.json` using Firebase CLI:
     ```bash
     firebase deploy --only firestore:rules,firestore:indexes
     ```
4. **Register Android App**:
   - In Project Settings, click **Add app → Android**.
   - Package name: `com.litewire.app`
   - Download `google-services.json` and place it at:
     `android-project/app/google-services.json`
5. **(Optional) Push Notifications**:
   - Deploy `firebase/functions/index.js` on Firebase Blaze plan for data-only FCM wakeups:
     ```bash
     firebase deploy --only functions
     ```

## 3. Building the Signed Release APK in Android Studio / CLI
1. Open `android-project/` in **Android Studio Ladybug (2024.2+)** or newer.
2. Let Gradle sync `libs.versions.toml` dependencies (JDK 17 required).
3. Ensure `app/google-services.json` is present.
4. **Build Debug APK** (for testing on two physical Android phones via USB):
   ```bash
   ./gradlew assembleDebug
   ```
   Output: `app/build/outputs/apk/debug/app-debug.apk`
5. **Build Minified Release APK** (R8 shrinking + resource shrinking enabled):
   - Generate a signing keystore if you don't have one:
     ```bash
     keytool -genkey -v -keystore litewire-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias litewire
     ```
   - In Android Studio: **Build → Generate Signed Bundle / APK → APK**, select `litewire-release.jks`, and choose `release` build variant.
   - Or via CLI after configuring `signingConfigs` in `app/build.gradle.kts`:
     ```bash
     ./gradlew assembleRelease
     ```
   Output: `app/build/outputs/apk/release/app-release.apk`
