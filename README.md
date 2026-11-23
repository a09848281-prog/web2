# Remote Camera Web2

Android・iPad・PC対応の個人利用向け遠隔監視カメラシステムです。
旧web v3.8〜v4.1の画面構成とWeb2の機能を統合した独立プレビューです。

- Current Web / Android stability preview: `preview/v2.8.4-battery-pairing-layout-stability`
- PWA: GitHub Pages（iPad Safari / PC browser）
- Android: Kotlin / Foreground Service / WebRTC
- Signaling and history: Google Apps Script + Google Sheets
- Live controls and media: WebRTC + DataChannel
- Firebase / FCM / paid AI API / VPS: not used
- No video recording, audio recording, or still-image saving

## Current stability preview

- Version: `2.8.3-preview`
- PWA preview: https://a09848281-prog.github.io/web2/v2.8.3/
- Branch: `preview/v2.8.3-fps-reconnect-stability`
- Android package: `jp.a09848281.remotecamera.v28` / versionCode 432
- Existing v2.8.0 APK can be updated in place by installing v2.8.3.
- Previous versions remain available; this branch does not overwrite main.

## v2.8.4 Battery, Pairing and Layout Stability Preview

- Branch: `preview/v2.8.4-battery-pairing-layout-stability`
- PWA: `https://a09848281-prog.github.io/web2/v2.8.4/`
- Android: `2.8.4-preview` / versionCode `433` / package `jp.a09848281.remotecamera.v29` (separate install so v2.8.3 `.v28` stays installed and its local settings are not removed). The new app has a fresh device ID and must be paired again in Web.
- Pairing-code lifetime is selected on Android: 10 minutes, 20 minutes, 30 minutes, 1 hour, or 2 hours. GAS validates the selected value and stores the corresponding expiry. Legacy clients without a duration still receive the 10-minute default.
- Battery auto-disconnect is opt-in and defaults OFF. When enabled, the user selects a 5–50% cutoff (default 20%). While not charging and at/below the threshold, the camera/microphone WebRTC session is closed and the torch is switched off.
- After cutoff, the wait toggle controls the behavior: ON keeps a foreground standby service and low-rate GAS polling active; OFF stops the service. Standby resumes after charging begins or battery rises at least 5 points above the threshold. Web reconnect is manual after standby, preventing surprise reconnect loops.
- Remaining battery time is estimated from actual battery percentage samples; it is hidden as “計測中” until there is at least 10 minutes of history and a measurable discharge. Charging clears the previous discharge estimate. It is an estimate, not a guaranteed runtime.
- Web keeps the left settings panel and right live viewer. The left panel can collapse, with its state remembered in the browser. A small battery/remaining-time indicator sits above the viewer controls.
- GAS API: `1.4.0`. The GAS script must be redeployed after replacing `gas/Code.gs`; the existing GAS URL and spreadsheet schema remain unchanged.
- See [V2.8.4-BATTERY-PAIRING-LAYOUT-STABILITY.md](V2.8.4-BATTERY-PAIRING-LAYOUT-STABILITY.md) for details and test limits.

## v2.8.3 FPS and Reconnect Stability Preview

- Branch: `preview/v2.8.3-fps-reconnect-stability`
- PWA: `https://a09848281-prog.github.io/web2/v2.8.3/`
- Android: `2.8.3-preview` / versionCode 432 / existing v28 package ID.
- **Actual FPS measurement:** Android counts frames delivered from the camera into the WebRTC video track; Web shows camera measured FPS separately from Web receiver decoded FPS. Selected camera FPS is no longer mistaken for actual output.
- **Camera capture:** Camera2 tries a fixed 30 FPS range first when the device advertises it. At 30 FPS and above, electronic stabilization is disabled to reduce processing overhead; optical stabilization remains available.
- **Load protection:** low battery / severe thermal protection reduces resolution first and keeps up to 30 FPS. Only critical thermal state limits FPS to 20 for device safety.
- **Adaptive quality:** automatic quality lowers resolution while preserving the chosen FPS.
- **Reconnect hardening:** connection attempts have stage-specific deadlines and a 45-second hard watchdog; stale attempt results are ignored. Signal polling reconnects after three consecutive errors. Reconnect timers do not stack behind a stalled connection attempt.
- **GAS polling:** Android signaling poll uses bounded connect/read timeouts so it cannot block the service poll loop indefinitely.
- Web design: app.css unchanged from v2.8.2.
- GAS URL and API 1.3.0 are unchanged; no GAS redeployment is required.
- See [V2.8.3-FPS-RECONNECT-STABILITY.md](V2.8.3-FPS-RECONNECT-STABILITY.md) for implementation and device test limits.

## v2.8.2 Command Stability Preview

- Branch: `preview/v2.8.2-command-stability`
- PWA: `https://a09848281-prog.github.io/web2/v2.8.2/`
- Web styles: `app.css` is unchanged from v2.8.1. Existing page structure and control positions are preserved.
- Android sleep control: removed as a Web command. Its original visual slot remains as a non-operational status so the page layout does not shift.
- Video watchdog: intentional camera OFF is ignored; camera, torch and profile changes receive a recovery grace period.
- Remote controls: camera/microphone toggles wait for Android acknowledgement and prevent repeated taps while pending. Other direct commands also check acknowledgement.
- Reconnect waits: 8s, 15s, 25s, 40s, 55s, then up to 60s between retries, while automatic reconnect remains enabled.
- GAS URL and API 1.3.0 are unchanged. No GAS redeploy is required.
- Android source/APK is unchanged; v2.8.0 Android APK remains the compatible camera-side app.
- See [V2.8.2-COMMAND-STABILITY.md](V2.8.2-COMMAND-STABILITY.md) for checks and device-test limitations.

## v2.8.0 Stable Reconnect Preview

- Branch: `preview/v2.8.0-stable-reconnect`
- PWA: `https://a09848281-prog.github.io/web2/v2.8.0/`
- Android version: `2.8.0-preview` / versionCode `431` / package `jp.a09848281.remotecamera.v28`
- Android package ID: `jp.a09848281.remotecamera.v28`. It installs alongside v2.7.1 so the older app and its local data are not overwritten. Pair the new app as a new Android device in the Web UI.
- GAS API remains `1.3.0`; the existing GAS URL and spreadsheet schema do not need to change.
- See [V2.8.0-STABLE-RECOVERY.md](V2.8.0-STABLE-RECOVERY.md) for the recovery and FPS behavior.

## Setup

1. Deploy `gas/Code.gs` as a Google Apps Script Web App.
2. Confirm `gasUrl` in `config.json` points to the deployed `/exec` URL. Do not commit TURN credentials or other secrets.
3. Publish the PWA with the `Deploy Remote Camera Web2 Previews to GitHub Pages` workflow. It publishes versioned preview folders including `/v2.8.3/` alongside older versions without replacing them.
4. Build the Android APK with the `Android APK Build` workflow. Download the `remote-camera-web2-preview-v2.8.3-apk` artifact.
5. Follow `docs/WEB2-V2.1.0-CHECKLIST.md` for Galaxy A22 5G / Android 13 and iPad Safari tests.

## v2.7.1 Fixes Preview

- Branch: `preview/v2.7.1-fixes`
- Android package: `jp.a09848281.remotecamera.v26` / `2.7.1-preview` (versionCode 430). The package ID is unchanged, so Android can install it as an update to v2.6.1.
- PWA: `https://a09848281-prog.github.io/web2/v2.7.1/`
- APK artifact: `remote-camera-web2-preview-v2.7.1-apk`
- **Web microphone:** starts automatically as the RTC connection is set up. The Web microphone button becomes an ON/OFF toggle. Permission denial does not intentionally block the camera-view setup; the user can retry from the button. Android receive audio remains active for full-duplex sound.
- **Noise control:** the 0–100 slider is now applied in the Web Audio receive path using an adaptive noise gate. 0 bypasses the gate; larger values attenuate low-level background sound more strongly. This is software gating, not full spectral noise cancellation, and a high setting can also reduce quiet speech. The setting is stored locally in the Web viewer.
- **Android sleep prevention (historical):** v2.7.1 / v2.8.0 could control Android display wake from Web. This control is disabled in the current v2.8.2 Web client; the button slot remains as an inactive status to preserve layout.
- **Zoom:** the viewer can be dragged to pan around the enlarged image; reset returns to the center.
- **Flashlight:** v2.7.1 moves flashlight control into the active WebRTC Camera2 repeating request using `FLASH_MODE_TORCH`, rather than calling `CameraManager.setTorchMode()` while the camera is occupied. The selected rear camera must expose flash support. Physical behavior still needs verification on the target Android phone; a successful CI build does not prove the LED works on every device.
- Android screen sharing and AccessibilityService controls remain excluded. Recording and image saving remain excluded.

- **自動復旧:** DataChannel切断、ICE切断、接続セットアップのタイムアウト、映像停止、ネットワーク復帰、PWA復帰を検知します。最初は高速に再試行し、失敗が続くと最大15秒まで間隔を広げます。
- **Android側:** 切断後45秒間、GASのシグナリングを1秒間隔で確認します。
- **画角:** Camera2が個別の背面カメラとして公開しているレンズから、画角が最も広いものを選べます。端末が複数レンズを1台の論理カメラとして公開する場合は切替できません。
- v2.6.1の記録は [V2.6.1-STABILITY.md](V2.6.1-STABILITY.md) に残しています。v2.7の詳細は [V2.7-AUTO-RECOVERY.md](V2.7-AUTO-RECOVERY.md) を確認してください。

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


See [V2.7.1-FIXES.md](V2.7.1-FIXES.md) for second-precision scheduling, first-attempt recovery, Camera2 torch integration, and 40/45/50/55 FPS support. The APK must be installed and `gas/Code.gs` redeployed to API 1.3.0 for APK schedule display in the Web UI. The previous v2.7.0 preview remains available at `/v2.7/`.
