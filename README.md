# Remote Camera Web2 v1.2

Android 13 / iPad PWA / PC browser remote camera system.

This repository is a clean successor project. The existing `a09848281-prog/web` repository is not modified.

## Architecture

- Android: Kotlin native APK, Android Foreground Service, WebRTC
- iPad / PC: HTML, CSS, JavaScript PWA
- Signaling and pairing: Google Apps Script + Google Sheets
- Live media: WebRTC
- Live controls and telemetry after connection: WebRTC DataChannel
- Up to 3 separately paired Web controllers per Android device
- Bookmarklet quick launch that contains no authentication token and does not auto-start the camera
- GAS + Google Sheets only for signaling and device settings; no WebSocket server, Firebase, FCM, VPS, or paid signaling backend
- Browser-side motion detection only (no person recognition or area/intrusion analysis)
- Motion event metadata history, CSV export, and optional browser notifications
- Automatic bitrate/quality adaptation when quality or data mode is set to Auto
- Optional TURN relay configuration through private GAS Script Properties
- Viewer-only digital zoom and dark-scene brightness correction; Android optical lens switching where exposed by Camera2
- Ambient/balanced/voice Android microphone capture presets, separate browser receive gain (0–200%), RMS audio meter, half-duplex PTT lock and 3-minute safety cutoff
- Video freeze/initial-frame watchdog, fullscreen playback restore, connection uptime and live RTC stats
- Portrait 9:16 camera capture ratio (applied on next RTC session)
- No paid AI API, recording, screenshots, or media storage

## Important connection behavior

GAS is used for pairing and SDP/ICE signaling. Once a WebRTC control DataChannel is open, live camera, audio, setting, status, and diagnostic messages use DataChannel directly. While fewer than 3 Web controllers are connected, Android retains only the selected low-frequency GAS check to admit additional paired viewers; when 3 sessions are active, that check pauses. No live control is sent through GAS after DataChannel opens.

WebRTC always has a public Google STUN fallback. For restrictive NATs, optional TURN can be configured in the Apps Script Project Settings → Script Properties. Add `TURN_URLS` (JSON array or comma-separated TURN/TURNS URLs), `TURN_USERNAME`, and `TURN_CREDENTIAL`. The values are never stored in this public repository. A TURN provider/relay and valid credentials are still required; GAS is only the configuration/signaling path and is not a TURN relay itself.

## First setup

1. Create a Google Sheet and open Extensions → Apps Script.
2. Paste the current v1.2 `gas/Code.gs`, save, and run `setupDatabase()` for a new installation. Existing v1.1 users only need to update the existing Apps Script project and redeploy it as a new version; the Settings sheet stores microphone mode inside its existing JSON value.
3. Deploy as a Web App (execute as you, access according to your private-use needs) and copy the `/exec` URL.
4. Replace `GAS_EXEC_URL_HERE` in `config.json` with that URL.
5. Android reads the same URL from this repository's raw `config.json`; no separate APK URL edit is needed.
6. Open Settings → Pages and set Build and deployment → Source to **GitHub Actions**. This one-time repository setting must be done by the repository owner.
7. Open Actions → Deploy PWA to GitHub Pages → Run workflow. After the first successful deployment, the PWA URL is `https://a09848281-prog.github.io/web2/`.
8. Open the PWA URL on iPad / PC. On Android, install the debug APK from the latest successful Android APK Build run.
9. Open the Android app while it is visible, grant camera/microphone permissions (location is optional), choose the GAS polling interval (1–50 seconds, default 10), and tap **監視待機を開始**. The Android screen contains only pairing-code issue/refresh, polling interval, background start, and stop controls.
10. Enter the displayed 8-digit, one-use, 10-minute pairing code on the Web page.

## v1.2 audio and camera controls

- Inbound Android microphone audio is routed through Web Audio where supported. The separate iPad/PC receive volume is adjustable from 0 to 200%; values over 100% can distort and are limited by the device/browser audio output.
- Android speaker volume is separate and controls sound played by the Android phone for PTT return audio.
- Audio meter shows local RMS level from the incoming Android audio track. It does not record or store sound.
- Android microphone presets: Ambient (MIC source with hardware echo cancellation/noise suppression disabled), Balanced, and Voice. A preset change is stored immediately and applied when the last current viewer disconnects and a fresh RTC engine is created. Hardware support differs by device.
- PTT is half-duplex: Android return audio is muted while transmitting. PTT lock is available, with a 3-minute automatic stop as a safety measure. Space/Enter keyboard shortcuts work when focus is not inside a form field.
- Browser Screen Wake Lock can be requested while connected; it only works on supported browsers and may be released by the operating system.
- Video watchdog detects missing initial frames after 15 seconds and frozen frames after 8 seconds, then triggers bounded reconnect. Fullscreen and iOS video-playback restoration do not recreate the PeerConnection.
- FPS, video bit rate, RTT, packet loss, connection time and GAS request latency are shown in the Web console.
- Capture aspect ratio includes 16:9, 4:3, 1:1 and 9:16. A camera capture aspect change applies on the next fresh RTC session; FPS/bitrate can still change during a session.

## v1.2 audio, camera and motion

- Receive audio is played through a browser-local Web Audio gain node; the iPad/PC receive volume is separate from Android speaker volume.
- Android mic mode is applied when the next RTC engine is created. Ambient mode disables hardware AEC and noise suppression to preserve environmental sound; device DSP differs by manufacturer.
- Screen Wake Lock is browser-dependent. It does not keep Android's screen awake.
- The camera capture aspect ratio is selected for the next RTC session; current viewers continue using the existing camera capture format.

## v1.2 motion detection

- Motion is calculated from low-resolution temporary frames in the currently open Web viewer. It runs only while the live video is connected and the page is visible.
- Only timestamp, movement score, sensitivity, and source metadata are saved to Google Sheets. No image, thumbnail, or video frame is saved or uploaded.
- Motion events are rate-limited and de-duplicated. Failed metadata uploads are queued locally per Android device and retried.
- Browser notifications require browser support and explicit user permission; an in-page alert remains available.
- CSV contains only motion event metadata.

## APK build

GitHub Actions builds `android/app/build/outputs/apk/debug/app-debug.apk` and uploads it as an artifact. A successful build proves compilation only; it does not prove camera operation on every device. Test on the Galaxy A22 5G / Android 13 before relying on it.

## Safety and Android limits

- A user must start the foreground waiting service from the visible Android app.
- Android may delay custom polling intervals in Doze / battery saver.
- Android does not allow an app to bypass force-stop, power-off, revoked permissions, or all camera/microphone background restrictions.
- No guarantee of uninterrupted 24/7 availability is possible on an ordinary Android phone.
- No guarantee of zero crashes can be made without device testing. Known failure paths are guarded and reported rather than silently crashing.
- The app does not record or save audio/video or capture/save still images. Incoming audio metering is calculated in memory only.
- Network diagnostics exclude credentials and never transmit Wi-Fi passwords.
- Process-death restart uses Android Foreground Service sticky restart and retry; it cannot survive force-stop, device reboot in all cases, revoked permission, or OEM battery termination.
- A partial wake lock is held only while at least one WebRTC viewer is connected.
- Viewer zoom and night-scene brightness adjustment affect only that browser's displayed video, not the camera sensor or the other viewers.
- Automatic quality adaptation requires the Web quality or data-mode selector to be set to Auto.

See `docs/WEB2-SPECIFICATION.md` and `docs/CRASH-PREVENTION.md`.
