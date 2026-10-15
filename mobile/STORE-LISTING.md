# Publishing checklist: Google Play and Apple App Store

## 1. Accounts (one-time)
- **Google Play Console**: US$25 one-time. Organisation account needs a D-U-N-S number; personal accounts must run a closed test with 12+ testers for 14 days before production.
- **Apple Developer Program**: US$99/year. Organisation enrolment needs a D-U-N-S number (takes a few days).

## 2. Must be ready before you submit (both stores)
1. **Privacy policy URL**: `https://supplydesk.in/privacy.html` (draft written; please have it reviewed and confirm the support email).
2. **Account deletion**: both stores require users to be able to ask for deletion. The policy page says "email support@supplydesk.in". Apple prefers an in-app option; a "Delete my account" button on the buyer and supplier dashboards is the next build item.
3. **Demo login for the reviewers** (Apple and Google both ask). Create a test buyer and a test supplier and give the credentials in the review notes. Buyers sign in by email OTP, so create a reviewer account that has a fixed, documented code or a pre-verified session.
4. **Screenshots**: iPhone 6.7" (1290x2796), iPhone 6.5", iPad 13" if you support iPad; Android phone (min 2 images). Take them from the real app.
5. **Short + full description**, category **Business**, age rating (no objectionable content; 4+ / Everyone).
6. **Data safety / App Privacy forms**: data collected = name, email, phone, company, uploaded documents, order history, device ID/push token; used for app functionality and account management; not sold; encrypted in transit.

## 3. Apple review (Guideline 4.2 "minimum functionality")
Apple can reject apps that are only a website in a frame. This app's native value: native splash/status bar, offline handling, push notifications for order, invoice and payment updates, file/photo upload, and sign-in. Push notifications must be switched on before submitting (needs an Apple push key and Firebase; ask me to wire the backend). Write the review notes as: "B2B procurement app for registered buyers, suppliers and staff; orders, invoices, document upload and notifications."

## 4. Android signing and release
```bash
keytool -genkeypair -v -keystore supplydesk-upload.jks -alias supplydesk -keyalg RSA -keysize 2048 -validity 10000
```
Keep the keystore and passwords somewhere safe (losing it is painful; enrol in Play App Signing). For CI, store as repository secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; the workflow then produces `app-release.aab` to upload in Play Console.

## 5. iOS signing and upload
Open `ios/App/App.xcworkspace` on a Mac, set the Team and bundle id `in.supplydesk.app`, then Product > Archive > Distribute (TestFlight first). Or use Codemagic / Xcode Cloud if you do not have a Mac.

## 6. Push notifications (optional but recommended)
Needs: a Firebase project, `google-services.json` in `android/app/`, an APNs key uploaded to Firebase, device-token registration endpoint and send logic in the server. Not built yet.

## 7. Release process
Website changes: normal deploy, app updates instantly. App changes (icons, config, plugins): bump `versionCode` / `versionName` (android/app/build.gradle) and `CFBundleVersion` (Xcode), build and upload again.
