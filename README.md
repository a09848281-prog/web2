# Remote Camera Web2 v2.1.1 Preview

Android・iPad・PC対応の個人利用向け遠隔監視カメラシステムです。
旧web v3.8〜v4.1の画面構成とWeb2の機能を統合した独立プレビューです。

- Preview branch: `preview/v2.1.0-stability`
- PWA: GitHub Pages（iPad Safari / PC browser）
- Android: Kotlin / Foreground Service / WebRTC
- Signaling and history: Google Apps Script + Google Sheets
- Live controls and media: WebRTC + DataChannel
- Firebase / FCM / paid AI API / VPS: not used
- No video recording, audio recording, or still-image saving

## Current preview

- App version: `2.1.1-preview`
- Android versionCode: `423`
- PWA preview: https://a09848281-prog.github.io/web2/v2.1/
- Branch: `preview/v2.1.0-stability`
- Bug fixes: viewport recovery loop, camera-OFF switching, viewer-capacity polling, microphone preset synchronization, Service Worker cache isolation, and camera shutdown order.

## Setup

1. Deploy `gas/Code.gs` as a Google Apps Script Web App.
2. Confirm `gasUrl` in `config.json` points to the deployed `/exec` URL. Do not commit TURN credentials or other secrets.
3. Publish the PWA with the `Deploy v2.1.0 Preview to GitHub Pages` workflow.
4. Build the Android APK with the `Android APK Build` workflow. Download the `remote-camera-web2-preview-v2.1.1-apk` artifact.
5. Follow `docs/WEB2-V2.1.0-CHECKLIST.md` for the Galaxy A22 5G / Android 13 and iPad Safari checks.

## v2.5 Remote Screen Preview

- Preview branch: `preview/v2.5-remote-screen`
- PWA: `https://a09848281-prog.github.io/web2/v2.5/` (published by `Deploy v2.5 Preview to GitHub Pages`)
- Android APK artifact: `remote-camera-web2-preview-v2.5.1-apk` (versionCode 426 / versionName 2.5.1-preview)
- The new **画面** tab requests Android screen sharing only when opened while connected. Normal camera monitoring does not start screen capture.
- Android's system screen-capture permission is required for every new sharing session. If Android is in the background, tap the Remote Camera screen-share notification, then confirm the system dialog.
- Remote tap/swipe/navigation/text/app launch commands require the user to enable the optional `Remote Camera操作サービス` in Android Accessibility settings.
- Screen video is carried on a second WebRTC video track, separate from the existing camera video. Only Web sessions that requested screen sharing are enabled as recipients.
- The screen stream stops when the request is cancelled, the viewer leaves the screen tab, or its RTC session ends. Protected/secure Android views remain subject to OS restrictions.

## v2.5.1 Stability corrections

- When the Android app is already in the foreground, a Web screen-share request automatically opens the Android system consent screen. When Android is in the background, the notification still needs to be tapped; Android's per-session screen-capture consent cannot be suppressed.
- The screen viewer now matches the received Android display aspect ratio in portrait and landscape orientations and caps the longest capture edge at 1440 pixels / 20 FPS to reduce load on mid-range devices.
- Web disconnect waits for Android DataChannel acknowledgements before closing the local PeerConnection, then sends the existing GAS/WebRTC bye fallback. Android also removes failed/closed ICE sessions and disposes the last viewer's camera/audio resources.
- Flashlight-off cleanup is a no-op when this app did not turn the torch on. If the active camera owns the only rear flash, Android may still reject a request to turn the light on while camera capture is active.
- Android's **Web接続時の撮影設定** is a saved profile for the next Web camera session; it does not capture or record while waiting.
- Added regression checks for RTC shutdown, torch cleanup and portrait/landscape screen sizing. GitHub Actions compilation does not replace Galaxy A22 / Android 13 and iPad Safari physical-device testing.

See [V2.5-REMOTE-SCREEN.md](V2.5-REMOTE-SCREEN.md) for the feature and platform limitation details.

## Location delivery

- While a WebRTC DataChannel is open, Android sends each acquired location directly to authenticated Web controllers.
- GAS + Sheets stores durable location history. Live delivery is not blocked by a GAS delay or failure.
- If the RTC control channel is unavailable, the Web map uses GAS history refresh as a fallback.
- Connected and idle location tracking are independently configurable. Actual acquisition timing depends on GPS/network providers, permissions, battery restrictions, and OS scheduling.

## Stability and platform limits

- A successful CI run confirms source checks and APK compilation; it does not certify Galaxy A22 / Android 13 or iPad Safari runtime behavior.
- Android force-stop, reboot-before-service-start, revoked permissions, OEM battery restrictions and Doze may interrupt background waiting.
- WakeLock/Wi-Fi Lock reduce some interruptions but do not override Android's camera, foreground-service or battery restrictions.
- iPad Safari may suspend or limit page/WebRTC activity while backgrounded.
- STUN fallback is configured. Some NATs require a separately hosted TURN relay and credentials in GAS Script Properties.
- The original `a09848281-prog/web` repository and the `main` branch are not modified by this preview branch.
