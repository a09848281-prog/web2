# Remote Camera Web2

Android 13 / iPad PWA / PC browser remote camera system.

This repository is a clean successor project. The existing `a09848281-prog/web` repository is not modified.

## Architecture

- Android: Kotlin native APK, Android Foreground Service, WebRTC
- iPad / PC: HTML, CSS, JavaScript PWA
- Signaling and pairing: Google Apps Script + Google Sheets
- Live media: WebRTC
- Live controls and telemetry after connection: WebRTC DataChannel
- No Firebase, FCM, paid AI API, recording, screenshots, or media storage

## Important connection behavior

GAS is used only before / during WebRTC establishment for pairing and SDP/ICE signaling. Once the WebRTC control DataChannel is open, normal camera, audio, setting, status, and diagnostic messages use the DataChannel. GAS polling pauses while that channel is open and resumes only after a connection loss that requires re-signaling.

WebRTC may require STUN/TURN depending on the networks. This repository starts with STUN-only configuration; connections across restrictive NATs may fail without a TURN relay.

## First setup

1. Create a Google Sheet and open Extensions → Apps Script.
2. Paste `gas/Code.gs`, save, and run `setupDatabase()` once.
3. Deploy as a Web App (execute as you, access according to your private-use needs) and copy the `/exec` URL.
4. Replace `GAS_EXEC_URL_HERE` in `config.json` with that URL.
5. Also set `GAS_EXEC_URL_HERE` in `android/app/src/main/java/jp/a09848281/remotecamera/Config.kt` or keep the remote config URL pointed at this repository's raw `config.json`.
6. Enable GitHub Pages for this repository (Settings → Pages; deploy from GitHub Actions).
7. Open the Pages URL on iPad / PC. On Android, install the debug APK from the latest successful Actions run.
8. Open the Android app while it is visible, grant requested permissions, choose the background polling interval, and tap **監視待機を開始**.
9. Enter the displayed 8-digit, one-use, 10-minute pairing code on the Web page.

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
