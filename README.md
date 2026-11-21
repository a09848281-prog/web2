# Remote Camera Web2

Android 13 / iPad PWA / PC browser remote camera system.

This repository is a clean successor project. The existing `a09848281-prog/web` repository is not modified.

## Architecture

- Android: Kotlin native APK, Android Foreground Service, WebRTC
- iPad / PC: HTML, CSS, JavaScript PWA
- Signaling and pairing: Google Apps Script + Google Sheets
- Live media: WebRTC
- Live controls and telemetry after connection: WebRTC DataChannel
- Up to 3 separately paired Web controllers per Android device
- GAS + Google Sheets only for signaling and device settings; no WebSocket server, Firebase, FCM, VPS, or paid signaling backend
- No paid AI API, recording, screenshots, or media storage

## Important connection behavior

GAS is used for pairing and SDP/ICE signaling. Once a WebRTC control DataChannel is open, live camera, audio, setting, status, and diagnostic messages use DataChannel directly. While fewer than 3 Web controllers are connected, Android retains only the selected low-frequency GAS check to admit additional paired viewers; when 3 sessions are active, that check pauses. No live control is sent through GAS after DataChannel opens.

WebRTC uses a public Google STUN endpoint. Restrictive NATs may still require a TURN relay; TURN is not included in this initial version.

## First setup

1. Create a Google Sheet and open Extensions → Apps Script.
2. Paste `gas/Code.gs`, save, and run `setupDatabase()`. When upgrading to v4.1, run it again to create the new Controllers sheet; existing rows are preserved.
3. Deploy as a Web App (execute as you, access according to your private-use needs) and copy the `/exec` URL.
4. Replace `GAS_EXEC_URL_HERE` in `config.json` with that URL.
5. Android reads the same URL from this repository's raw `config.json`; no separate APK URL edit is needed.
6. Open Settings → Pages and set Build and deployment → Source to **GitHub Actions**. This one-time repository setting must be done by the repository owner.
7. Open Actions → Deploy PWA to GitHub Pages → Run workflow. After the first successful deployment, the PWA URL is `https://a09848281-prog.github.io/web2/`.
8. Open the PWA URL on iPad / PC. On Android, install the debug APK from the latest successful Android APK Build run.
9. Open the Android app while it is visible, grant camera/microphone permissions (location is optional), choose the GAS polling interval (1–50 seconds, default 10), and tap **監視待機を開始**. The Android screen contains only pairing-code issue/refresh, polling interval, background start, and stop controls.
10. Enter the displayed 8-digit, one-use, 10-minute pairing code on the Web page.

## APK build

GitHub Actions builds `android/app/build/outputs/apk/debug/app-debug.apk` and uploads it as an artifact. A successful build proves compilation only; it does not prove camera operation on every device. Test on the Galaxy A22 5G / Android 13 before relying on it.

## Safety and Android limits

- A user must start the foreground waiting service from the visible Android app.
- Android may delay custom polling intervals in Doze / battery saver.
- Android does not allow an app to bypass force-stop, power-off, revoked permissions, or all camera/microphone background restrictions.
- No guarantee of uninterrupted 24/7 availability is possible on an ordinary Android phone.
- No guarantee of zero crashes can be made without device testing. Known failure paths are guarded and reported rather than silently crashing.
- The app does not record or save audio/video.
- Network diagnostics exclude credentials and never transmit Wi-Fi passwords.

See `docs/WEB2-SPECIFICATION.md` and `docs/CRASH-PREVENTION.md`.
