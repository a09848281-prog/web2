# Remote Camera Web2

Android・iPad・PC対応の個人利用向け遠隔監視カメラシステムです。
旧web v3.8〜v4.1の画面構成とWeb2の機能を統合した独立プレビューです。

- Current stability preview: `preview/v2.6-stability`
- PWA: GitHub Pages（iPad Safari / PC browser）
- Android: Kotlin / Foreground Service / WebRTC
- Signaling and history: Google Apps Script + Google Sheets
- Live controls and media: WebRTC + DataChannel
- Firebase / FCM / paid AI API / VPS: not used
- No video recording, audio recording, or still-image saving

## Current stability preview

- App version: `2.6.0-preview`
- Android versionCode: `427`
- PWA preview: https://a09848281-prog.github.io/web2/v2.6/
- Branch: `preview/v2.6-stability`
- Previous v2.1 preview: https://a09848281-prog.github.io/web2/v2.1/
- v2.6 prioritizes notification/foreground-service shutdown, Web PTT microphone release, camera/flashlight cleanup, and display-awake control.

## Setup

1. Deploy `gas/Code.gs` as a Google Apps Script Web App.
2. Confirm `gasUrl` in `config.json` points to the deployed `/exec` URL. Do not commit TURN credentials or other secrets.
3. Publish the PWA with the `Deploy v2.6 Preview to GitHub Pages` workflow. The workflow preserves the root site and v2.1/v2.5 preview paths.
4. Build the Android APK with the `Android APK Build` workflow. Download the `remote-camera-web2-preview-v2.6.0-apk` artifact.
5. Follow `docs/WEB2-V2.1.0-CHECKLIST.md` for the Galaxy A22 5G / Android 13 and iPad Safari checks.

## v2.6 Stability Preview

- Branch: `preview/v2.6-stability`
- Android package: `2.6.0-preview` (versionCode 427)
- PWA: `https://a09848281-prog.github.io/web2/v2.6/`
- Android APK artifact: `remote-camera-web2-preview-v2.6.0-apk`
- Android screen sharing and its AccessibilityService controls have been removed from this release.
- The Web microphone is not requested during page load or RTC connection. It is requested only after the user presses the PTT control; release, disconnect, page-background, and RTC failure paths stop the local microphone track.
- The notification's **待機を停止** action uses a dedicated BroadcastReceiver and stops the foreground service without attempting to start another foreground service. Shutdown disposes RTC, camera/audio resources, torch state, Wi-Fi and power locks, and the notification.
- Android display-awake can be toggled locally or from Web while connected. It prevents automatic display sleep while its wake lock is held, can increase battery use, and does not bypass the PIN/pattern/biometric lock screen.
- Android's standard hardware NoiseSuppressor is an ON/OFF feature in this build: 0 = OFF; values 1–100 request the standard ON state. The number is retained as a UI value, not a measured cancellation-strength percentage; the standard hardware effect switches ON/OFF in real time during an active media session. The 1–100 number is a request/UI value, not a measured cancellation-strength percentage; the current Android WebRTC audio module does not expose continuous 0–100 DSP intensity.
- Turning an already-off flashlight off is now a no-op. Turning the flash on can still be rejected by a device if its camera hardware resources are busy.
- GitHub Actions compilation and automated tests do not replace physical tests on Galaxy A22 / Android 13 and iPad Safari.

See [V2.6-STABILITY.md](V2.6-STABILITY.md) for the revised lifecycle and known platform limits.

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
