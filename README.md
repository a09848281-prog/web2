# Remote Camera Web2 v2.0.1 Preview

旧web v3.8 / v3.9 / v4.0 / v4.1の機能・画面デザインと、Web2 v1.2の改善を統合する独立プレビュー版です。

- Branch: `preview/v2.0.1-location-rtc`
- Android: Kotlin / Foreground Service / WebRTC
- iPad / PC: GitHub Pages PWA
- Signaling: Google Apps Script + Google Sheets
- Connected controls and media: WebRTC + DataChannel
- Firebase / FCM / paid AI API / VPS: not used
- No recording, audio recording or saved still images

## Design
The UI returns to the old v4.1 visual structure: dark navy header, left collapsible settings groups, large right-side live view and prominent PTT toolbar above the video. The v1.2 telemetry, motion events, location follow, device information, connection reservation and bookmarklet remain available.

## Setup
1. Deploy the current `gas/Code.gs` as a Google Apps Script Web App. The API contract remains compatible with v1.2.
2. Set `gasUrl` in `config.json` to your real `https://script.google.com/macros/s/.../exec` URL. Never commit credentials or TURN secrets.
3. Enable GitHub Pages using GitHub Actions in repository settings if you need to publish the PWA.
4. Android APK is built by the `Android APK Build` workflow when this preview branch is pushed. Install only after reviewing the build artifact.
5. Follow `docs/WEB2-V2.0-PREVIEW-CHECKLIST.md` for device checks.

## Location delivery in v2.0.1
- While a WebRTC DataChannel is open, Android sends each acquired location directly to every authenticated Web controller. The map updates from this live message without waiting for a GAS read.
- GAS + Sheets remains the durable location history store. Android attempts the history write after sending the live update; live delivery is not blocked by a GAS delay or failure.
- If the RTC control channel is unavailable, the Web map retains its 30-second GAS history refresh as a fallback.
- Connected and idle location tracking remain independently switchable in the location panel. The configured intervals are applied immediately over DataChannel while connected and persisted on Android for the foreground service.
- The foreground service checks the interval every 5 seconds, but real acquisition can take longer due to GPS/network provider availability, permissions, battery restrictions, and OS scheduling. The app cannot promise exact-time updates.

## Cautions
- Successful CI means source checks and APK compilation succeeded; it does not certify Galaxy A22 / Android 13 or iPad Safari runtime behavior.
- Android force-stop, reboot-before-service-start, revoked permissions, OEM battery restrictions and Doze may interrupt background waiting.
- STUN fallback is configured. Some NATs require a separately hosted TURN relay and credentials in GAS Script Properties.
- The original `a09848281-prog/web` repository and the `main` branch remain unchanged.
