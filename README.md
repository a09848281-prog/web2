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

- App version: `2.6.1-preview`
- Android versionCode: `428`
- PWA preview: https://a09848281-prog.github.io/web2/v2.6.1/
- Branch: `preview/v2.6.1-stability`
- Previous v2.6 preview remains available: https://a09848281-prog.github.io/web2/v2.6/
- Previous v2.1 preview: https://a09848281-prog.github.io/web2/v2.1/

## Setup

1. Deploy `gas/Code.gs` as a Google Apps Script Web App.
2. Confirm `gasUrl` in `config.json` points to the deployed `/exec` URL. Do not commit TURN credentials or other secrets.
3. Publish the PWA with the `Deploy v2.6 Preview to GitHub Pages` workflow. It publishes the v2.6.1 preview at `/v2.6.1/` without replacing the older preview folders.
4. Build the Android APK with the `Android APK Build` workflow. Download the `remote-camera-web2-preview-v2.6.1-apk` artifact.
5. Follow `docs/WEB2-V2.1.0-CHECKLIST.md` for Galaxy A22 5G / Android 13 and iPad Safari tests.

## v2.6.1 Stability Preview

- Branch: `preview/v2.6.1-stability`
- Android package: `jp.a09848281.remotecamera.v26` / `2.6.1-preview` (versionCode 428). The package ID is unchanged from v2.6, so Android can install it as an update to v2.6.
- PWA: `https://a09848281-prog.github.io/web2/v2.6.1/`
- APK artifact: `remote-camera-web2-preview-v2.6.1-apk`
- **Web microphone:** starts automatically as the RTC connection is set up. The Web microphone button becomes an ON/OFF toggle. Permission denial does not intentionally block the camera-view setup; the user can retry from the button. Android receive audio remains active for full-duplex sound.
- **Noise control:** the 0–100 slider is now applied in the Web Audio receive path using an adaptive noise gate. 0 bypasses the gate; larger values attenuate low-level background sound more strongly. This is software gating, not full spectral noise cancellation, and a high setting can also reduce quiet speech. The setting is stored locally in the Web viewer.
- **Android sleep prevention:** the APK's local sleep toggle has been removed. The Web viewer is the only control surface. The Android foreground service applies a screen wake lock, reports whether the lock is actually held, and acknowledges ON/OFF changes. It does not bypass the PIN/pattern/biometric lock and can increase battery use.
- **Zoom:** the viewer can be dragged to pan around the enlarged image; reset returns to the center.
- **Flashlight:** the service now tracks the actual torch callback and no longer keeps a failed ON request pending until a later camera flip. Android's public `CameraManager.setTorchMode()` can reject the flash while the same camera resource is in use. On phones where the rear camera and flash cannot run simultaneously through this API, the light still cannot be forced on while that rear camera is actively streaming. The Web UI reports actual state rather than claiming it is on. See the platform note below.
- Android screen sharing and AccessibilityService controls remain excluded. Recording and image saving remain excluded.

See [V2.6.1-STABILITY.md](V2.6.1-STABILITY.md) for implementation details, checks and known hardware limits.

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
