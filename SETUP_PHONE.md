# LiteWire on two phones (no server needed)

## A. Firebase (free, from your phone browser)
1. console.firebase.google.com -> Create a project (turn Analytics off).
2. Build -> Authentication -> Get started -> Email/Password -> Enable.
3. Build -> Firestore Database -> Create database -> Production mode.
4. Firestore -> Rules tab -> replace everything with the contents of
   android-project/firebase/firestore.rules -> Publish.
5. Project settings (gear) -> Add app -> Android. Package name: com.litewire.app
   -> Register -> Download google-services.json.

## B. GitHub secret
6. Your repo -> Settings -> Secrets and variables -> Actions -> New repository secret.
   Name: GOOGLE_SERVICES_JSON   Value: the full text of google-services.json.

## C. Build and install
7. Push this folder to the repo (the workflow builds on push), or Actions ->
   Build LiteWire APK -> Run workflow.
8. When green: open the run -> Artifacts -> litewire-debug -> unzip -> install the .apk
   on BOTH phones (allow "install unknown apps").
9. Create two accounts (any email + password 8+ chars), search each other's @username, chat.
