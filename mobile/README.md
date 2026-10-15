# SupplyDesk mobile app (iOS + Android)

A Capacitor app that opens **https://supplydesk.in** full screen, with a native splash screen, status bar,
offline page and (when configured) push notifications. One website, one backend: every website
change shows up in the app immediately; the app itself only needs a new release when this folder changes.

- App id: `in.supplydesk.app` · Name: `SupplyDesk`
- Buyers, suppliers and the SupplyDesk team use the same login pages as the website.

## Build locally

```bash
cd mobile
npm install
npm run assets              # regenerates icons/splash from resources/ (only after changing resources/)
npx cap sync

# Android (needs JDK 21 + Android SDK, ANDROID_HOME set)
npm run android:debug       # -> android/app/build/outputs/apk/debug/app-debug.apk (install on a phone)
npm run android:release     # -> signed bundle needs your upload keystore (see STORE-LISTING.md)

# iOS (needs a Mac with Xcode)
npm run ios:open            # opens Xcode; pick your Team, then Product > Archive
```

GitHub Actions (`.github/workflows/mobile.yml`) builds the Android APK and an iOS simulator build on every change.

## What is in the app

| Item | Where |
|---|---|
| Website address, allowed domains, offline page | `capacitor.config.json`, `www/` |
| Icon, adaptive icon, splash | `resources/` (source) -> generated into `android/` and `ios/` |
| Notch / safe-area, status bar colour | `../assets/native-app.js` (loaded by every website page, no effect in a browser) |

See `STORE-LISTING.md` for accounts, store assets, signing and the review checklist.
