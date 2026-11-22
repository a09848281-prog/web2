package jp.a09848281.remotecamera

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.PowerManager
import android.os.Process
import java.net.NetworkInterface
import java.util.Collections
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class MonitorService : Service() {
    companion object {
        const val ACTION_START = "jp.a09848281.remotecamera.START"
        const val ACTION_REFRESH_CODE = "jp.a09848281.remotecamera.REFRESH_CODE"
        const val ACTION_STOP = "jp.a09848281.remotecamera.STOP"
        const val ACTION_VIDEO_SETTINGS = "jp.a09848281.remotecamera.VIDEO_SETTINGS"
        const val ACTION_DISPLAY_AWAKE = "jp.a09848281.remotecamera.DISPLAY_AWAKE"
        const val ACTION_CODE = "jp.a09848281.remotecamera.CODE"
        const val EXTRA_GAS_URL = "gas_url"
        const val EXTRA_POLL_INTERVAL_SECONDS = "poll_interval_seconds"
        const val EXTRA_CODE = "registration_code"
        const val EXTRA_DEVICE_ID = "device_id"
        private const val CHANNEL = "remote_camera_monitor"
        private const val NOTIFICATION_ID = 7301
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs by lazy { getSharedPreferences(AppConfig.PREFS, Context.MODE_PRIVATE) }
    private var gasUrl = ""
    private var api: ApiClient? = null
    private var rtc: RtcEngine? = null
    private var pollJob: Job? = null
    private var locationJob: Job? = null
    private var afterSeq = 0
    @Volatile private var connectedLocationEnabled = false
    @Volatile private var idleLocationEnabled = false
    @Volatile private var connectedInterval = 30L
    @Volatile private var idleInterval = 300L
    private var currentQuality = "720"
    private var currentDataMode = "standard"
    private var currentFps = 24
    private var lastDevicePollAt = 0L
    private var lastTelemetryAt = 0L
    private val dataChannelCommandMutex = Mutex()
    private var lastAppliedSettingsSignature = ""
    @Volatile private var lastLocationAttempt = 0L
    private var lastCodeRefresh = 0L
    private var pollIntervalSeconds = AppConfig.POLL_SECONDS
    private var trafficBaselineTx = -1L
    private var trafficBaselineRx = -1L
    private var lastTrafficTx = 0L
    private var lastTrafficRx = 0L
    private var lastTrafficAt = 0L
    private var lastNetworkError = ""
    @Volatile private var recoveryPollUntil = 0L
    private val apiReady = CompletableDeferred<Unit>()
    private var streamWakeLock: PowerManager.WakeLock? = null
    private var streamWifiLock: WifiManager.WifiLock? = null
    private var displayWakeLock: PowerManager.WakeLock? = null
    private var lastUsageSampleAt = 0L
    private var powerSaveActive = false
    private var torchEnabled = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep the foreground service and its notification while the user removes the UI task.
        super.onTaskRemoved(rootIntent)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (!prefs.getBoolean("v210MicMigrationComplete", false)) {
            prefs.edit()
                .putString("micMode", "balanced")
                .putInt("micNoise", prefs.getInt("micNoise", 70))
                .putBoolean("v210MicMigrationComplete", true)
                .apply()
        }
        val restoredAfterProcessDeath = intent == null && prefs.getBoolean("monitoringEnabled", false)
        if (intent == null && !restoredAfterProcessDeath) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (action == ACTION_STOP) {
            stopMonitoringNow(startId)
            return START_NOT_STICKY
        }
        // Ignore a delayed/stale START intent after the user has explicitly stopped waiting.
        if (action == ACTION_START && !prefs.getBoolean("monitoringEnabled", false)) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (intent != null && action != ACTION_START && action != ACTION_REFRESH_CODE && action != ACTION_VIDEO_SETTINGS && action != ACTION_DISPLAY_AWAKE) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        gasUrl = intent?.getStringExtra(EXTRA_GAS_URL)
            ?: prefs.getString("gasUrl", "")
            ?: ""
        if (!gasUrl.startsWith("https://script.google.com/macros/s/") ||
            !gasUrl.endsWith("/exec") || gasUrl.contains("GAS_EXEC_URL_HERE") ||
            gasUrl.contains("PASTE_YOUR_DEPLOYMENT_ID")) {
            prefs.edit().putBoolean("monitoringEnabled", false).apply()
            stopSelf(startId)
            return START_NOT_STICKY
        }
        prefs.edit().putString("gasUrl", gasUrl).apply()
        val requestedPoll = intent?.getIntExtra(
            EXTRA_POLL_INTERVAL_SECONDS,
            prefs.getInt("pollIntervalSeconds", AppConfig.POLL_SECONDS.toInt())
        ) ?: prefs.getInt("pollIntervalSeconds", AppConfig.POLL_SECONDS.toInt())
        pollIntervalSeconds = requestedPoll.coerceIn(AppConfig.MIN_POLL_SECONDS,AppConfig.MAX_POLL_SECONDS).toLong()
        prefs.edit().putInt("pollIntervalSeconds",pollIntervalSeconds.toInt()).apply()
        // Restore the saved next-connection camera profile before the first RTC offer.
        currentQuality = (prefs.getString("requestedQuality", "720") ?: "720").let { if (it in setOf("360", "480", "720", "1080")) it else "720" }
        currentDataMode = "standard"
        currentFps = prefs.getInt("fps", 24).coerceIn(10, 60)
        try { startMonitoringForeground() } catch(e:Exception) {
            Log.e("RemoteCameraService","Foreground startup rejected by Android",e)
            prefs.edit().putBoolean("monitoringEnabled",false).apply()
            stopSelf(startId)
            return START_NOT_STICKY
        }

        if (pollJob?.isActive != true) pollJob = scope.launch { pollLoop() }
        if (locationJob?.isActive != true) locationJob = scope.launch { locationLoop() }

        if (action == ACTION_DISPLAY_AWAKE) {
            val enabled = intent?.getBooleanExtra("enabled", false) == true
            val applied = updateDisplayWakeLock(enabled)
            prefs.edit().putBoolean("androidKeepScreenAwake", enabled && applied).apply()
            if (enabled && !applied) notifyState("Androidの画面スリープ防止を開始できませんでした。省電力設定と画面制御の制限を確認してください。")
            sendTelemetry()
            return START_STICKY
        }

        if (action == ACTION_VIDEO_SETTINGS) {
            val quality = intent?.getStringExtra("quality") ?: prefs.getString("requestedQuality", "720") ?: "720"
            val fps = (intent?.getIntExtra("fps", prefs.getInt("fps", 24)) ?: 24).coerceIn(10, 60)
            val ratio = intent?.getStringExtra("aspectRatio") ?: prefs.getString("aspectRatio", "original") ?: "16:9"
            prefs.edit().putBoolean("nativeVideoOverride", true).apply()
            applyVideoSettings(JSONObject().put("quality", quality).put("fps", fps).put("aspectRatio", ratio))
            sendDeviceSettingsToOpenChannels()
            return START_STICKY
        }

        if (action == ACTION_REFRESH_CODE) {
            scope.launch {
                try {
                    withTimeout(30000L) { apiReady.await() }
                    refreshCode()
                } catch (e: Exception) {
                    notifyState("ペアリングコード再発行失敗：" + (e.message ?: "通信エラー"))
                }
            }
        }
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Remote Camera", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "遠隔監視の待機・接続状態を表示します。" }
            )
        }
    }

    private fun startMonitoringForeground() {
        createChannel()
        prefs.edit().putBoolean("monitoringEnabled", true).apply()
        updateForegroundNotification()
        updateDisplayWakeLock(prefs.getBoolean("androidKeepScreenAwake", false))
    }

    private fun updateForegroundNotification() {
        val notificationText = if (rtc?.hasPeers() == true) "監視接続中" else "監視待機中（接続要求を確認しています）"
        val foregroundNotification = notification(notificationText)
        if (Build.VERSION.SDK_INT >= 29) {
            // Keep camera/microphone service types declared from the user-initiated
            // foreground start. The hardware itself is opened only for active RTC peers.
            // This also avoids an illegal background upgrade to a while-in-use sensor FGS.
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            val hasLocation = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED
            if (hasLocation) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            startForeground(NOTIFICATION_ID, foregroundNotification, types)
        } else {
            startForeground(NOTIFICATION_ID, foregroundNotification)
        }
    }

    private fun stopActionPendingIntent(): PendingIntent {
        val stopIntent = Intent(this, StopMonitoringReceiver::class.java)
        return PendingIntent.getBroadcast(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun notification(text: String): Notification {
        val pending = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("Remote Camera")
            .setContentText(text)
            .setContentIntent(pending)
            .addAction(android.R.drawable.ic_media_pause, "待機を停止", stopActionPendingIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun stopMonitoringNow(startId: Int) {
        pollJob?.cancel()
        pollJob = null
        locationJob?.cancel()
        locationJob = null
        try { rtc?.setTorchEnabled(false) } catch (error: Exception) {
            Log.w("RemoteCameraService", "In-stream torch cleanup failed during explicit stop", error)
        }
        torchEnabled = false
        try { rtc?.dispose() } catch (error: Exception) {
            Log.e("RemoteCameraService", "RTC cleanup failed during explicit stop", error)
        }
        rtc = null
        updateStreamWakeLock(false)
        updateDisplayWakeLock(false)
        prefs.edit().putBoolean("monitoringEnabled", false).putBoolean("androidKeepScreenAwake", false).apply()
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        stopSelf(startId)
    }

    private fun notifyState(text: String) {
        // A delayed coroutine must never recreate the foreground notification after stop.
        if (!prefs.getBoolean("monitoringEnabled", false)) {
            try { getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID) } catch (_: Exception) {}
            return
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private suspend fun pollLoop() {
        try {
            api = ApiClient(gasUrl)
            ensureDevice()
            syncSavedScheduleToGas()
            if (!apiReady.isCompleted) apiReady.complete(Unit)
            while (scope.isActive) {
                sampleTrafficUsage()
                val controlOpen = rtc?.hasOpenControlChannel() == true
                val recoveryActive = System.currentTimeMillis() < recoveryPollUntil || (rtc?.peerCount() ?: 0) > 0
                if (!controlOpen && (rtc?.peerCount() ?: 0) == 0) {
                    // Reset the app-wide traffic baseline only after the last
                    // viewer leaves, not whenever another viewer connects.
                    trafficBaselineTx = -1L
                    trafficBaselineRx = -1L
                    lastTrafficTx = 0L
                    lastTrafficRx = 0L
                    lastTrafficAt = 0L
                }
                if (controlOpen) {
                    val now = System.currentTimeMillis()
                    // RTC DataChannel carries live controls and telemetry.
                    if (now - lastTelemetryAt >= 5000L) {
                        sendTelemetry()
                        lastTelemetryAt = now
                    }
                    // Keep polling even at viewer capacity: GAS remains the
                    // safety-net for revocation and additional viewer signaling.
                    val activePollInterval = maxOf(pollIntervalSeconds * 1000L, 10000L)
                    val elapsed = now - lastDevicePollAt
                    val untilNextPoll = activePollInterval - elapsed
                    if (untilNextPoll > 0L) {
                        delay(minOf(5000L, untilNextPoll))
                        continue
                    }
                } else if (recoveryActive) {
                    val elapsed = System.currentTimeMillis() - lastDevicePollAt
                    val untilNextPoll = 1000L - elapsed
                    if (untilNextPoll > 0L) {
                        delay(minOf(250L, untilNextPoll))
                        continue
                    }
                }
                lastDevicePollAt = System.currentTimeMillis()
                try {
                    val deviceId = prefs.getString("deviceId", "") ?: ""
                    val secret = prefs.getString("deviceSecret", "") ?: ""
                    val response = api!!.call(
                        "device_poll",
                        JSONObject().put("deviceId", deviceId).put("deviceSecret", secret).put("afterSeq", afterSeq)
                    )
                    rtc?.setIceServers(response.optJSONArray("iceServers"))
                    if (!response.optBoolean("registered", false)) {
                        prefs.edit().putBoolean("serverPaired", false).apply()
                        // A controller can revoke pairing remotely. Stop media immediately on the next poll.
                        rtc?.dispose()
                        rtc = null
                        updateStreamWakeLock(false)
                        val pairingCodeActive = response.optBoolean("pairingCodeActive", false)
                        if (!pairingCodeActive || System.currentTimeMillis() - lastCodeRefresh > 8 * 60 * 1000L) {
                            refreshCode()
                        }
                        notifyState("Android端末の登録待ち：Webに8桁コードを入力")
                    } else {
                        val needsPairing = response.optBoolean("needsPairing", false)
                        prefs.edit().putBoolean("serverPaired", !needsPairing).apply()
                        val codeActive = response.optBoolean("pairingCodeActive", false)
                        if (needsPairing) {
                            // No authenticated Web controller remains. Close any
                            // orphaned media session before issuing another code.
                            if (rtc != null) {
                                rtc?.dispose()
                                rtc = null
                                updateStreamWakeLock(false)
                            }
                            if (System.currentTimeMillis() - lastCodeRefresh > 8 * 60 * 1000L) {
                                refreshCode()
                            }
                        } else if (!codeActive && (prefs.getString("registrationCode", "") ?: "").isNotBlank()) {
                            prefs.edit().remove("registrationCode").apply()
                            broadcastCode("", deviceId)
                        }
                        applySettings(response.optJSONObject("settings") ?: JSONObject())
                        // Ignore pending offers/commands once all Web controllers have been revoked.
                        val signals = if (needsPairing) JSONArray() else (response.optJSONArray("signals") ?: JSONArray())
                        for (i in 0 until signals.length()) {
                            val signal = signals.optJSONObject(i) ?: continue
                            when (signal.optString("kind")) {
                                "offer" -> {
                                    if (signal.optString("sdp").isBlank()) continue
                                    val session = signal.optString("sessionId")
                                    try {
                                        val cameraGranted = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                                        val micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                                        if (!cameraGranted || !micGranted) {
                                            notifyState("接続できません：カメラ・マイクの権限を確認してください")
                                            continue
                                        }
                                        if (rtc == null) {
                                            val currentApi = api ?: continue
                                            rtc = RtcEngine(
                                                this, currentApi, deviceId, secret, scope, ::notifyState,
                                                onDataChannelMessage = ::handleDataChannelMessage,
                                                onConnectionState = ::onRtcConnectionState,
                                                microphoneMode = prefs.getString("micMode", "balanced") ?: "balanced",
                                                captureAspectRatio = prefs.getString("aspectRatio", "original") ?: "16:9"
                                            )
                                        }
                                        rtc?.setIceServers(response.optJSONArray("iceServers"))
                                        rtc?.setMicSensitivity(prefs.getInt("micSensitivity", 70))
                                        rtc?.setMicGain(prefs.getInt("micGain", 100))
                                        rtc?.setNightMode(prefs.getBoolean("nightMode", false))
                                        rtc?.handleOffer(session, signal.optString("sdp"))
                                        rtc?.setQuality(currentQuality, currentDataMode, currentFps, prefs.getString("aspectRatio", "original") ?: "16:9")
                                        notifyState("接続要求を処理しています")
                                    } catch (e: Exception) {
                                        Log.e("RemoteCameraService", "Offer handling failed; keep foreground service alive", e)
                                        notifyState("接続開始に失敗しました：" + (e.message ?: "詳細不明") + "。待機は継続します")
                                    }
                                }
                                "bye" -> {
                                    closeRtcViewerSession(signal.optString("sessionId"))
                                    notifyState("Web側から切断要求を受信しました")
                                }
                            }
                        }
                        val commands = if (needsPairing) JSONArray() else (response.optJSONArray("commands") ?: JSONArray())
                        for (i in 0 until commands.length()) processCommand(commands.optJSONObject(i) ?: continue)
                        // Advance only after this poll's signals and commands have been handed to the handlers.
                        afterSeq = maxOf(afterSeq, response.optInt("latestSeq", afterSeq))
                        prefs.edit().putInt("afterSeq", afterSeq).apply()
                        notifyState(if (rtc?.hasPeers() == true) "監視中・接続済み" else "監視待機中")
                    }
                } catch (cancelled: CancellationException) {
                    // Explicit stop cancels this job. Never convert that into an error
                    // notification or schedule a retry after the user stopped waiting.
                    throw cancelled
                } catch (e: Exception) {
                    if (!scope.isActive || !prefs.getBoolean("monitoringEnabled", false)) throw e
                    Log.e("RemoteCameraService", "Polling iteration failed; foreground service remains active", e)
                    lastNetworkError=e.message ?: "Polling iteration failed"
                    if (rtc?.hasOpenControlChannel() == true) {
                        val diagnostic = networkInfo()
                            .put("androidVersion", Build.VERSION.RELEASE)
                            .put("apiLevel", Build.VERSION.SDK_INT)
                            .put("deviceModel", Build.MODEL ?: "Android")
                            .put("rtcControlChannelOpen", true)
                            .put("recentError", lastNetworkError)
                        rtc?.sendControlToOpenDataChannels(
                            JSONObject().put("type", "network_diagnostic").put("data", diagnostic)
                        )
                    }
                    notifyState("通信または接続処理に失敗しました。待機を継続して再試行します")
                }
                // Connected mode uses a short scheduler tick, then the
                // elapsed-time gate above enforces the configured 1–50s interval.
                delay(if (rtc?.hasOpenControlChannel()==true) 250L else pollIntervalSeconds*1000L)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (e: Exception) {
            if (!scope.isActive || !prefs.getBoolean("monitoringEnabled", false)) throw e
            Log.e("RemoteCameraService", "Initial GAS registration failed; retry will continue", e)
            lastNetworkError = e.message ?: "Initial GAS registration failed"
            notifyState("初期接続に失敗しました。5秒後に自動再試行します")
            // Keep apiReady pending so a manual pairing-code refresh can complete
            // after the retry succeeds instead of retaining a permanent failed Deferred.
            scope.launch {
                delay(5000L)
                if (scope.isActive && prefs.getBoolean("monitoringEnabled", false)) {
                    pollJob = scope.launch { pollLoop() }
                }
            }
        }
    }


    private fun onRtcConnectionState(sessionId:String,state:String) {
        when(state) {
            "DATA_CHANNEL_OPEN" -> {
                recoveryPollUntil = 0L
                updateStreamWakeLock(true)
                if (trafficBaselineTx < 0L || trafficBaselineRx < 0L) {
                    trafficBaselineTx=TrafficStats.getUidTxBytes(Process.myUid())
                    trafficBaselineRx=TrafficStats.getUidRxBytes(Process.myUid())
                    lastTrafficTx=0L;lastTrafficRx=0L;lastTrafficAt=System.currentTimeMillis()
                }
                notifyState("監視中・DataChannel直接通信")
                rtc?.sendCameraCapabilities(sessionId)
                sendDeviceSettings(sessionId)
                if (lastNetworkError.isNotBlank()) {
                    val reason = lastNetworkError
                    scope.launch {
                        delay(250L)
                        sendNetworkDiagnostic(sessionId, reason)
                    }
                }
            }
            "FAILED", "CLOSED", "SESSION_REMOVED", "DATA_CHANNEL_CLOSED" -> {
                recoveryPollUntil = System.currentTimeMillis() + 45000L
                lastDevicePollAt = 0L
                lastNetworkError = "WebRTC / DataChannel state: " + state
                // Defer disposal out of the WebRTC observer callback. FAILED is
                // immediately removed by RtcEngine; SESSION_REMOVED is the final cleanup signal.
                scope.launch(Dispatchers.IO) {
                    delay(120L)
                    closeRtcViewerSession(sessionId)
                    updateForegroundNotification()
                    updateStreamWakeLock(rtc?.hasPeers() == true)
                    notifyState(if (rtc?.hasPeers() == true) "ほかのWeb端末は監視を継続中" else "監視待機中")
                }
            }
            "DISCONNECTED" -> {
                recoveryPollUntil = System.currentTimeMillis() + 45000L
                lastDevicePollAt = 0L
                // Poll for a replacement offer while ICE gets a short recovery grace period.
                scope.launch {
                    delay(9000L)
                    val engine = rtc
                    if (engine != null && engine.hasSession(sessionId) &&
                        engine.iceConnectionState(sessionId) == "DISCONNECTED") {
                        closeRtcViewerSession(sessionId)
                    } else if (engine != null && !engine.hasPeers()) {
                        engine.dispose()
                        if (rtc === engine) rtc = null
                        updateForegroundNotification()
                    }
                    updateStreamWakeLock(rtc?.hasPeers() == true)
                }
            }
        }
    }

    private fun closeRtcViewerSession(sessionId: String) {
        val engine = rtc ?: return
        engine.closeSession(sessionId)
        updateStreamWakeLock(engine.hasPeers())
        // AudioDeviceModule presets are fixed at PeerConnectionFactory creation.
        // Dispose the empty engine so the next viewer receives the selected preset.
        if (!engine.hasPeers()) {
            engine.dispose()
            if (rtc === engine) rtc = null
            updateStreamWakeLock(false)
            updateForegroundNotification()
        }
    }

    private fun applyMicModeSetting(settings: JSONObject): String {
        val requested = settings.optString("micMode", prefs.getString("micMode", "balanced") ?: "balanced")
        val mode = if (requested in setOf("ambient", "balanced", "voice")) requested else "balanced"
        prefs.edit().putString("micMode", mode).apply()
        return "マイク集音モードを" + when (mode) {
            "voice" -> "声重視"
            "balanced" -> "バランス"
            else -> "環境音重視"
        } + "に設定しました。次回接続から反映します。"
    }

    private fun handleDataChannelMessage(sessionId:String,raw:String) {
        // WebRTC observer callbacks may arrive back-to-back. Serialize camera,
        // torch and settings operations so an older command cannot overwrite a newer one.
        scope.launch(Dispatchers.IO) {
            dataChannelCommandMutex.withLock {
                var requestId = ""
                var commandName = ""
                try {
                    val req = JSONObject(raw)
                    if (req.optString("type") != "command") return@withLock
                    requestId = req.optString("requestId")
                    commandName = req.optString("command")
                    val payload = req.optJSONObject("payload") ?: JSONObject()
                    val result = executeDataChannelCommand(sessionId, commandName, payload)
                    rtc?.sendControl(sessionId, JSONObject()
                        .put("type", "ack").put("requestId", requestId)
                        .put("ok", true).put("message", result))
                    if (commandName == "disconnect") {
                        delay(150L)
                        closeRtcViewerSession(sessionId)
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (!scope.isActive || !prefs.getBoolean("monitoringEnabled", false)) throw error
                    try {
                        rtc?.sendControl(sessionId, JSONObject()
                            .put("type", "ack").put("requestId", requestId)
                            .put("ok", false)
                            .put("message", error.message ?: "命令を適用できませんでした"))
                    } catch (_: Exception) {}
                    if (commandName != "disconnect") {
                        lastNetworkError = "DataChannel命令エラー: " + (error.message ?: "不明")
                        sendNetworkDiagnostic(sessionId, lastNetworkError)
                        notifyState("DataChannel命令エラー：" + (error.message ?: "不明"))
                    }
                }
            }
        }
    }
    private suspend fun executeDataChannelCommand(sessionId:String,name:String,payload:JSONObject):String {
        when(name) {
            "camera" -> {
                val engine = rtc ?: error("WebRTCが終了しています。")
                val cameraId = payload.optString("cameraId", "")
                if (cameraId.isNotBlank() && cameraId != "back" && cameraId != "front") {
                    engine.selectCamera(cameraId)
                } else {
                    engine.switchCamera(payload.optString("facing", cameraId.ifBlank { "back" }))
                }
                // A rejected ON request is deliberately not retried after a camera
                // change. Switching to another camera must never surprise the user
                // by turning the flashlight on later.
            }
            "torch" -> setTorch(payload.optBoolean("enabled",false))
            "media_toggle" -> {
                val engine = rtc ?: error("WebRTCが終了しています。")
                if (payload.has("cameraEnabled")) engine.setCameraEnabled(payload.optBoolean("cameraEnabled"))
                if (payload.has("microphoneEnabled")) engine.setMicrophoneEnabled(payload.optBoolean("microphoneEnabled"))
                sendTelemetry()
            }
            "android_keep_awake" -> {
                val enabled = payload.optBoolean("enabled", false)
                if (!updateDisplayWakeLock(enabled)) {
                    error("Androidの画面点灯制御を適用できませんでした。端末の省電力設定を確認してください。")
                }
                prefs.edit().putBoolean("androidKeepScreenAwake", enabled).apply()
                sendTelemetry()
            }
            "volume","speaker_volume" -> {
                val pct=payload.optInt("percent",70).coerceIn(0,100)
                val audio=getSystemService(AUDIO_SERVICE) as AudioManager
                val stream=AudioManager.STREAM_MUSIC
                audio.mode = AudioManager.MODE_NORMAL
                audio.setStreamVolume(stream,(audio.getStreamMaxVolume(stream)*pct/100.0).toInt(),0)
            }
            "adaptive_quality" -> {
                if (!powerSaveActive) applyAdaptiveQuality(payload)
            }
            "quality","data_mode","settings_update" -> {
                // A deliberate controller update takes precedence over native standby presets.
                prefs.edit().putBoolean("nativeVideoOverride", false).apply()
                // Apply location tracking preferences immediately over the open RTC
                // channel; do not wait for the next GAS device_poll cycle.
                applyLocationSettings(payload)
                applyVideoSettings(payload)
                rtc?.setMicSensitivity(payload.optInt("micSensitivity",prefs.getInt("micSensitivity",70)))
                rtc?.setMicGain(payload.optInt("micGain",prefs.getInt("micGain",100)))
                val pct=payload.optInt("speakerVolume",70).coerceIn(0,100)
                val audio=getSystemService(AUDIO_SERVICE) as AudioManager
                val stream=AudioManager.STREAM_MUSIC
                audio.mode = AudioManager.MODE_NORMAL
                audio.setStreamVolume(stream,(audio.getStreamMaxVolume(stream)*pct/100.0).toInt(),0)
                rtc?.setNightMode(payload.optBoolean("nightMode",false))
                val micModeMessage = applyMicModeSetting(payload)
                prefs.edit().putString("quality",currentQuality).putString("dataMode",currentDataMode)
                    .putInt("fps",currentFps)
                    .putString("aspectRatio",payload.optString("aspectRatio","16:9"))
                    .putInt("micNoise",payload.optInt("micNoise",70).coerceIn(0,100))
                    .putInt("micSensitivity",payload.optInt("micSensitivity",70).coerceIn(0,100))
                    .putInt("micGain",payload.optInt("micGain",100).coerceIn(0,100))
                    .putInt("speakerVolume",pct)
                    .putBoolean("nightMode",payload.optBoolean("nightMode",false)).apply()
                sendTelemetry()
                if (payload.has("micMode")) return "$micModeMessage Android設定を保存しました。"
            }
            "mic_sensitivity" -> rtc?.setMicSensitivity(payload.optInt("percent",70))
            "mic_gain" -> rtc?.setMicGain(payload.optInt("percent",100))
            "night_mode" -> rtc?.setNightMode(payload.optBoolean("enabled",false))
            "diagnostics" -> sendNetworkDiagnostic(sessionId)
            "location_once" -> requestLocation("manual")
            "disconnect" -> return "切断要求を受信しました。"
            else -> error("未対応の命令："+name)
        }
        return "Androidで命令を受信しました。"
    }
    private fun networkInfo():JSONObject {
        val manager=getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val network=manager.activeNetwork
        val caps=if(network!=null)manager.getNetworkCapabilities(network) else null
        val links=if(network!=null)manager.getLinkProperties(network) else null
        val transport=when {
            caps==null -> "オフライン"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "モバイル通信"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            else -> "その他"
        }
        val ips=try {
            val all=NetworkInterface.getNetworkInterfaces()
            if(all==null)emptyList<String>() else Collections.list(all).flatMap { nic ->
                Collections.list(nic.inetAddresses).filter{!it.isLoopbackAddress}.mapNotNull{it.hostAddress?.substringBefore("%")}
            }.distinct()
        } catch(_:Exception){emptyList<String>()}
        return JSONObject().put("transport",transport)
            .put("validated",caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)==true)
            .put("metered",manager.isActiveNetworkMetered)
            .put("signalStrengthDbm",if(Build.VERSION.SDK_INT>=29)caps?.signalStrength?:-1 else -1)
            .put("dnsServers",JSONArray((links?.dnsServers?:emptyList()).map{it.hostAddress}))
            .put("localIpAddresses",JSONArray(ips))
            .put("networkInterface",links?.interfaceName?:"")
    }
    @Suppress("DEPRECATION")
    private fun updateDisplayWakeLock(enabled: Boolean): Boolean {
        return try {
            val power = getSystemService(POWER_SERVICE) as PowerManager
            if (enabled) {
                var lock = displayWakeLock
                if (lock == null) {
                    lock = power.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        packageName + ":remote-camera-display-awake"
                    )
                    lock.setReferenceCounted(false)
                    displayWakeLock = lock
                }
                if (!lock.isHeld) lock.acquire()
            } else {
                displayWakeLock?.let { if (it.isHeld) it.release() }
                displayWakeLock = null
            }
            true
        } catch (error: Exception) {
            Log.w("RemoteCameraService", "Could not update Android display wake lock", error)
            // Keep the WakeLock reference if release failed so a later OFF/stop
            // action can retry releasing it.
            false
        }
    }

    private fun updateStreamWakeLock(active: Boolean) {
        try {
            val power = getSystemService(POWER_SERVICE) as PowerManager
            val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            if (active) {
                var lock = streamWakeLock
                if (lock == null) {
                    lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, packageName + ":remote-camera-stream")
                    lock.setReferenceCounted(false)
                    streamWakeLock = lock
                }
                if (!lock.isHeld) lock.acquire()
                var wifiLock = streamWifiLock
                if (wifiLock == null) {
                    wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL, packageName + ":remote-camera-wifi")
                    wifiLock.setReferenceCounted(false)
                    streamWifiLock = wifiLock
                }
                if (!wifiLock.isHeld) wifiLock.acquire()
            } else {
                streamWifiLock?.let { if (it.isHeld) it.release() }
                streamWakeLock?.let { if (it.isHeld) it.release() }
            }
        } catch (error: Exception) {
            Log.w("RemoteCameraService", "Could not update stream/wifi wake locks", error)
        }
    }

    private fun setTorch(enabled: Boolean) {
        val engine = rtc ?: error("Androidカメラが接続されていません。")
        engine.setTorchEnabled(enabled)
        torchEnabled = engine.isTorchEnabled()
        sendTelemetry()
        notifyState(if (torchEnabled) "ライト ON（映像撮影中）" else "ライト OFF")
    }

    private fun sampleTrafficUsage() {
        val now = System.currentTimeMillis()
        if (now - lastUsageSampleAt < 30000L) return
        lastUsageSampleAt = now
        val uid = Process.myUid()
        val tx = TrafficStats.getUidTxBytes(uid)
        val rx = TrafficStats.getUidRxBytes(uid)
        if (tx < 0L || rx < 0L) return
        val previousTx = prefs.getLong("usageLastUidTx", -1L)
        val previousRx = prefs.getLong("usageLastUidRx", -1L)
        val deltaTx = if (previousTx >= 0L && tx >= previousTx) tx - previousTx else 0L
        val deltaRx = if (previousRx >= 0L && rx >= previousRx) rx - previousRx else 0L
        val daily = try { JSONObject(prefs.getString("usageDailyJson", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
        val key = SimpleDateFormat("yyyyMMdd", Locale.US).apply {
            timeZone = TimeZone.getDefault()
        }.format(Date(now))
        val day = daily.optJSONObject(key) ?: JSONObject().put("tx", 0L).put("rx", 0L)
        day.put("tx", day.optLong("tx", 0L) + deltaTx)
        day.put("rx", day.optLong("rx", 0L) + deltaRx)
        daily.put(key, day)
        val cutoff = SimpleDateFormat("yyyyMMdd", Locale.US).apply {
            timeZone = TimeZone.getDefault()
        }.format(Date(now - 30L * 24L * 60L * 60L * 1000L))
        val keys = daily.keys()
        val remove = mutableListOf<String>()
        while (keys.hasNext()) {
            val k = keys.next()
            if (k.length != 8 || k < cutoff) remove.add(k)
        }
        remove.forEach { daily.remove(it) }
        prefs.edit()
            .putLong("usageLastUidTx", tx)
            .putLong("usageLastUidRx", rx)
            .putString("usageDailyJson", daily.toString())
            .apply()
    }

    private fun getUsageTotals(): List<Long> {
        val uid = Process.myUid()
        if (TrafficStats.getUidTxBytes(uid) < 0L || TrafficStats.getUidRxBytes(uid) < 0L) {
            return listOf(-1L, -1L, -1L, -1L)
        }
        val daily = try { JSONObject(prefs.getString("usageDailyJson", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
        val keys7 = mutableListOf<String>()
        val keys30 = mutableListOf<String>()
        val calendar = java.util.Calendar.getInstance(TimeZone.getDefault(), Locale.US)
        val formatter = SimpleDateFormat("yyyyMMdd", Locale.US).apply { timeZone = TimeZone.getDefault() }
        val today = formatter.format(Date())
        for (offset in 0..29) {
            calendar.time = formatter.parse(today) ?: Date()
            calendar.add(java.util.Calendar.DAY_OF_YEAR, -offset)
            val key = formatter.format(calendar.time)
            keys30.add(key)
            if (offset <= 6) keys7.add(key)
        }
        fun sum(keys: List<String>, field: String): Long =
            keys.sumOf { daily.optJSONObject(it)?.optLong(field, 0L) ?: 0L }
        return listOf(sum(keys7, "tx"), sum(keys7, "rx"), sum(keys30, "tx"), sum(keys30, "rx"))
    }

    private fun sendDeviceSettings(sessionId: String) {
        val settings = JSONObject()
            .put("quality", prefs.getString("requestedQuality", "720") ?: "720")
            .put("fps", prefs.getInt("fps", 24))
            .put("aspectRatio", prefs.getString("aspectRatio", "original") ?: "16:9")
            .put("micNoise", prefs.getInt("micNoise", 70))
            .put("androidKeepAwake", displayWakeLock?.isHeld == true)
            .put("speakerVolume", prefs.getInt("speakerVolume", 70))
            .put("dataMode", "standard")
        rtc?.sendControl(sessionId, JSONObject().put("type", "device_settings").put("settings", settings))
    }

    private fun sendDeviceSettingsToOpenChannels() {
        val settings = JSONObject()
            .put("quality", prefs.getString("requestedQuality", "720") ?: "720")
            .put("fps", prefs.getInt("fps", 24))
            .put("aspectRatio", prefs.getString("aspectRatio", "original") ?: "16:9")
            .put("micNoise", prefs.getInt("micNoise", 70))
            .put("speakerVolume", prefs.getInt("speakerVolume", 70))
            .put("dataMode", "standard")
        rtc?.sendControlToOpenDataChannels(JSONObject().put("type", "device_settings").put("settings", settings))
    }

    private fun sendNetworkDiagnostic(sessionId:String,reason:String=lastNetworkError) {
        val data=networkInfo().put("androidVersion",Build.VERSION.RELEASE).put("apiLevel",Build.VERSION.SDK_INT)
            .put("deviceModel",Build.MODEL?:"Android").put("rtcControlChannelOpen",rtc?.hasOpenControlChannel()==true)
            .put("recentError",reason)
        rtc?.sendControl(sessionId,JSONObject().put("type","network_diagnostic").put("data",data))
        lastNetworkError=""
    }
    private fun sendTelemetry() {
        sampleTrafficUsage()
        val uid=Process.myUid()
        val txNow=TrafficStats.getUidTxBytes(uid);val rxNow=TrafficStats.getUidRxBytes(uid)
        if(trafficBaselineTx<0&&txNow>=0)trafficBaselineTx=txNow
        if(trafficBaselineRx<0&&rxNow>=0)trafficBaselineRx=rxNow
        val tx=if(txNow>=0&&trafficBaselineTx>=0)(txNow-trafficBaselineTx).coerceAtLeast(0L) else -1L
        val rx=if(rxNow>=0&&trafficBaselineRx>=0)(rxNow-trafficBaselineRx).coerceAtLeast(0L) else -1L
        val now=System.currentTimeMillis();val elapsed=if(lastTrafficAt>0)(now-lastTrafficAt).coerceAtLeast(1L) else 2000L
        val txSpeed=if(tx>=0)((tx-lastTrafficTx).coerceAtLeast(0L)*1000L/elapsed) else -1L
        val rxSpeed=if(rx>=0)((rx-lastTrafficRx).coerceAtLeast(0L)*1000L/elapsed) else -1L
        lastTrafficTx=tx.coerceAtLeast(0L);lastTrafficRx=rx.coerceAtLeast(0L);lastTrafficAt=now
        val battery=getSystemService(BATTERY_SERVICE) as BatteryManager
        val percent=battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val intent=registerReceiver(null,android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val rawTemp=intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE,-1)?:-1
        val temp=if(rawTemp>=0)rawTemp/10.0 else -1.0
        val batteryStatus=intent?.getIntExtra(BatteryManager.EXTRA_STATUS,BatteryManager.BATTERY_STATUS_UNKNOWN)
            ?: BatteryManager.BATTERY_STATUS_UNKNOWN
        val charging=batteryStatus==BatteryManager.BATTERY_STATUS_CHARGING || batteryStatus==BatteryManager.BATTERY_STATUS_FULL
        val thermal=if(Build.VERSION.SDK_INT>=29)(getSystemService(POWER_SERVICE) as PowerManager).currentThermalStatus else -1
        val shouldReduceLoad = (percent in 0..15) || (thermal >= PowerManager.THERMAL_STATUS_SEVERE)
        if (shouldReduceLoad && rtc != null && !powerSaveActive) {
            powerSaveActive = true
            applyVideoSettings(JSONObject())
            notifyState("バッテリー・温度保護：映像を低負荷設定にしました")
        } else if (!shouldReduceLoad && powerSaveActive) {
            powerSaveActive = false
            applyVideoSettings(JSONObject())
            notifyState("端末温度・バッテリーが回復したため映像設定を戻しました")
        }
        val usage = getUsageTotals()
        val capture = rtc?.captureInfo() ?: JSONObject()
        val flashAvailable = capture.optBoolean("flashAvailable", false)
        torchEnabled = capture.optBoolean("flashEnabled", false)
        val audio = getSystemService(AUDIO_SERVICE) as AudioManager
        val musicMax = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val speakerPercent = (audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100.0 / musicMax).toInt().coerceIn(0, 100)
        val data=JSONObject().put("type","telemetry").put("txBytesSinceConnect",tx).put("rxBytesSinceConnect",rx)
            .put("txBytesPerSecond",txSpeed).put("rxBytesPerSecond",rxSpeed)
            .put("txBytes7d", usage[0]).put("rxBytes7d", usage[1])
            .put("txBytes30d", usage[2]).put("rxBytes30d", usage[3])
            .put("captureWidth", capture.optInt("width", 0))
            .put("captureHeight", capture.optInt("height", 0))
            .put("captureFps", capture.optInt("fps", 0))
            .put("cameraEnabled", capture.optBoolean("cameraEnabled", true))
            .put("microphoneEnabled", capture.optBoolean("microphoneEnabled", true))
            .put("speakerVolumePercent", speakerPercent)
            .put("micNoise", prefs.getInt("micNoise", 70))
            .put("androidKeepAwake", displayWakeLock?.isHeld == true)
            .put("batteryPercent",percent)
            .put("batteryCharging",charging).put("batteryTempC",temp).put("thermalStatus",thermal)
            .put("androidVersion",Build.VERSION.RELEASE).put("deviceModel",Build.MODEL ?: "Android")
            .put("cameraFacing",rtc?.currentCameraFacing() ?: "未接続")
            .put("cameraId",rtc?.currentCameraId() ?: "")
            .put("flashAvailable",flashAvailable).put("flashEnabled",torchEnabled)
            .put("microphoneMode",prefs.getString("micMode","balanced") ?: "balanced")
            .put("network",networkInfo())
        rtc?.sendControlToOpenDataChannels(data)
    }

    private suspend fun syncSavedScheduleToGas() {
        val startAt = prefs.getLong("scheduleStartAt", 0L)
        val endAt = prefs.getLong("scheduleEndAt", 0L)
        if (startAt <= 0L || endAt <= startAt) return
        try {
            api?.call("save_device_schedule", JSONObject()
                .put("deviceId", prefs.getString("deviceId", ""))
                .put("deviceSecret", prefs.getString("deviceSecret", ""))
                .put("startAt", startAt).put("endAt", endAt))
            Log.i("RemoteCameraSchedule", "Saved APK schedule synchronized to GAS.")
        } catch (error: Exception) {
            Log.w("RemoteCameraSchedule", "Saved APK schedule sync will be retried on next service start.", error)
        }
    }

    private suspend fun ensureDevice() {
        var id = prefs.getString("deviceId", "") ?: ""
        var secret = prefs.getString("deviceSecret", "") ?: ""
        if (id.isBlank() || secret.isBlank()) {
            id = UUID.randomUUID().toString()
            val response = api!!.call("device_begin", JSONObject().put("deviceId", id).put("deviceName", Build.MODEL ?: "Android"))
            secret = response.getString("deviceSecret")
            prefs.edit().putString("deviceId", id).putString("deviceSecret", secret)
                .putBoolean("serverPaired", false).putInt("afterSeq", 0).apply()
            afterSeq = 0
            showPairingCode(response.optString("registrationCode"), id)
        } else {
            afterSeq = prefs.getInt("afterSeq", 0)
            val saved = prefs.getString("registrationCode", "") ?: ""
            if (saved.isNotBlank()) broadcastCode(saved, id)
        }
    }

    private suspend fun refreshCode() {
        val response = api!!.call(
            "device_refresh_code",
            JSONObject().put("deviceId", prefs.getString("deviceId", ""))
                .put("deviceSecret", prefs.getString("deviceSecret", ""))
        )
        showPairingCode(response.optString("registrationCode"), prefs.getString("deviceId", "") ?: "")
    }

    private fun showPairingCode(code: String, id: String) {
        lastCodeRefresh = System.currentTimeMillis()
        prefs.edit().putString("registrationCode", code).putLong("codeRefreshedAt", lastCodeRefresh).apply()
        broadcastCode(code, id)
        notifyState("端末登録待ち：8桁コードをWebへ入力")
    }

    private fun broadcastCode(code: String, id: String) {
        sendBroadcast(
            Intent(ACTION_CODE).setPackage(packageName)
                .putExtra(EXTRA_CODE, code).putExtra(EXTRA_DEVICE_ID, id)
        )
    }

    private fun applyVideoSettings(settings: JSONObject) {
        val requestedQuality = settings.optString(
            "quality", prefs.getString("requestedQuality", "720") ?: "720"
        ).takeIf { it in setOf("auto", "360", "480", "720", "1080") } ?: "720"
        // v2.1 removes the confusing data-mode selector. Resolution and FPS
        // directly determine the requested camera/encoder profile.
        val requestedDataMode = "standard"
        val previousQuality = prefs.getString("requestedQuality", "720") ?: "720"
        val previousFps = prefs.getInt("fps", 24)
        val previousRatio = prefs.getString("aspectRatio", "original") ?: "16:9"
        val requestedFpsRaw = settings.optInt("fps", previousFps)
        val requestedFps = requestedFpsRaw.takeIf { it in setOf(10, 15, 20, 24, 30, 40, 45, 50, 55, 60) } ?: 24
        val requestedRatio = settings.optString("aspectRatio", previousRatio)
            .takeIf { it in setOf("16:9", "4:3", "1:1", "9:16", "original") } ?: "16:9"
        val requestChanged = requestedQuality != previousQuality ||
            requestedFps != previousFps || requestedRatio != previousRatio
        val editor = prefs.edit()
            .putString("requestedQuality", requestedQuality)
            .putString("requestedDataMode", requestedDataMode)
            .putInt("fps", requestedFps)
            .putString("aspectRatio", requestedRatio)
        if (requestChanged) {
            editor.remove("adaptiveQuality")
                .remove("adaptiveDataMode")
                .remove("adaptiveFps")
        }
        editor.apply()

        currentQuality = if (requestedQuality == "auto") {
            prefs.getString("adaptiveQuality", "720") ?: "720"
        } else requestedQuality
        currentDataMode = if (requestedDataMode == "auto") {
            prefs.getString("adaptiveDataMode", "standard") ?: "standard"
        } else requestedDataMode
        val automatic = requestedQuality == "auto"
        currentFps = if (automatic) {
            prefs.getInt("adaptiveFps", requestedFps).coerceIn(10, 60)
        } else requestedFps
        if (powerSaveActive) {
            currentQuality = "360"
            currentDataMode = "ultra"
            currentFps = 10
        }
        rtc?.setQuality(currentQuality, currentDataMode, currentFps, prefs.getString("aspectRatio", "original") ?: "16:9")
    }

    private fun applyAdaptiveQuality(payload: JSONObject) {
        if (powerSaveActive) return
        val requestedQuality = prefs.getString("requestedQuality", "720") ?: "720"
        val requestedDataMode = prefs.getString("requestedDataMode", "standard") ?: "standard"
        if (requestedQuality != "auto" && requestedDataMode != "auto") return

        val quality = payload.optString("quality", currentQuality)
        val dataMode = payload.optString("dataMode", currentDataMode)
        val allowedQuality = setOf("360", "480", "720", "1080")
        val allowedMode = setOf("auto", "ultra", "save", "standard", "high")
        if (quality !in allowedQuality || dataMode !in allowedMode) {
            throw IllegalArgumentException("自動画質の指定が不正です。")
        }
        val fps = payload.optInt("fps", currentFps).coerceIn(10, 60)
        currentQuality = if (requestedQuality == "auto") quality else requestedQuality
        currentDataMode = if (requestedDataMode == "auto") dataMode else requestedDataMode
        currentFps = fps
        prefs.edit()
            .putString("adaptiveQuality", quality)
            .putString("adaptiveDataMode", dataMode)
            .putInt("adaptiveFps", fps)
            .apply()
        rtc?.setQuality(currentQuality, currentDataMode, currentFps, prefs.getString("aspectRatio", "original") ?: "16:9")
    }

    private fun applyLocationSettings(settings: JSONObject) {
        connectedLocationEnabled = settings.optBoolean("connectedLocationEnabled", connectedLocationEnabled)
        idleLocationEnabled = settings.optBoolean("idleLocationEnabled", idleLocationEnabled)
        connectedInterval = settings.optLong("connectedInterval", connectedInterval).coerceIn(10, 3600)
        idleInterval = settings.optLong("idleInterval", idleInterval).coerceIn(10, 3600)
        prefs.edit()
            .putBoolean("connectedLocationEnabled", connectedLocationEnabled)
            .putBoolean("idleLocationEnabled", idleLocationEnabled)
            .putLong("connectedInterval", connectedInterval)
            .putLong("idleInterval", idleInterval)
            .apply()
    }

    private fun applySettings(settings: JSONObject) {
        val signatureKeys = listOf(
            "quality", "dataMode", "fps", "aspectRatio", "micNoise", "micSensitivity",
            "micGain", "micMode", "speakerVolume", "nightMode",
            "connectedLocationEnabled", "idleLocationEnabled", "connectedInterval", "idleInterval"
        )
        val signature = signatureKeys.joinToString("|") { key ->
            if (settings.has(key)) settings.opt(key).toString() else "<default>"
        }
        if (signature == lastAppliedSettingsSignature) return
        lastAppliedSettingsSignature = signature

        // One-time migration: old installations used 16:9 as a hard-coded default.
        // New v2.1.2 installs and existing default profiles should follow the camera sensor.
        val effectiveSettings = JSONObject(settings.toString())
        if (!prefs.getBoolean("v212OriginalAspectMigrationComplete", false)) {
            if (effectiveSettings.optString("aspectRatio", "16:9") == "16:9") {
                effectiveSettings.put("aspectRatio", "original")
            }
            prefs.edit().putBoolean("v212OriginalAspectMigrationComplete", true).apply()
        }
        applyLocationSettings(effectiveSettings)
        if (!prefs.getBoolean("nativeVideoOverride", false)) applyVideoSettings(effectiveSettings)
        val micNoise = settings.optInt("micNoise", prefs.getInt("micNoise", 0)).coerceIn(0, 100)
        val micSensitivity = settings.optInt("micSensitivity", prefs.getInt("micSensitivity", 0)).coerceIn(0, 100)
        val micGain = settings.optInt("micGain", prefs.getInt("micGain", 100)).coerceIn(0, 100)
        val speakerVolume = settings.optInt("speakerVolume", prefs.getInt("speakerVolume", 70)).coerceIn(0, 100)
        val nightMode = settings.optBoolean("nightMode", prefs.getBoolean("nightMode", false))
        val micMode = settings.optString("micMode", prefs.getString("micMode", "balanced") ?: "balanced")
            .takeIf { it in setOf("ambient", "balanced", "voice") } ?: "ambient"
        prefs.edit().putInt("micNoise", micNoise)
            .putInt("micSensitivity", micSensitivity).putInt("micGain", micGain)
            .putInt("speakerVolume", speakerVolume).putBoolean("nightMode", nightMode)
            .putString("micMode", micMode).apply()
        rtc?.setMicSensitivity(micSensitivity)
        rtc?.setMicGain(micGain)
        rtc?.setNightMode(nightMode)
        try {
            val audio = getSystemService(AUDIO_SERVICE) as AudioManager
            audio.mode = AudioManager.MODE_NORMAL
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, (max * speakerVolume / 100.0).toInt(), 0)
        } catch (_: Exception) {}
    }

    private suspend fun processCommand(command: JSONObject) {
        val name = command.optString("command")
        val commandId = command.optString("commandId")
        val payload = command.optJSONObject("payload") ?: JSONObject()
        var succeeded = true
        try {
            when (name) {
                "location_once" -> requestLocation("manual")
                "location_settings" -> {
                    applySettings(payload)
                    prefs.edit().putBoolean("connectedLocationEnabled", connectedLocationEnabled)
                        .putBoolean("idleLocationEnabled", idleLocationEnabled)
                        .putLong("connectedInterval", connectedInterval)
                        .putLong("idleInterval", idleInterval).apply()
                }
                "camera" -> (rtc ?: error("映像接続中ではありません。")).switchCamera(payload.optString("facing", "back"))
                "volume" -> {
                    val percent = payload.optInt("percent", 70).coerceIn(0, 100)
                    val audio = getSystemService(AUDIO_SERVICE) as AudioManager
                    val stream = AudioManager.STREAM_MUSIC
                    audio.mode = AudioManager.MODE_NORMAL
                    val max = audio.getStreamMaxVolume(stream)
                    audio.setStreamVolume(stream, (max * percent / 100.0).toInt(), 0)
                }
                "adaptive_quality" -> applyAdaptiveQuality(payload)
                "quality", "data_mode" -> {
                    prefs.edit().putBoolean("nativeVideoOverride", false).apply()
                    applyVideoSettings(payload)
                }
                "disconnect" -> {
                    val sessionId = payload.optString("sessionId", "")
                    if (sessionId.isNotBlank()) {
                        // A Web viewer may only close its own PeerConnection.
                        closeRtcViewerSession(sessionId)
                    } else {
                        // Legacy unscoped disconnect is retained only for older clients.
                        rtc?.dispose()
                        rtc = null
                        updateStreamWakeLock(false)
                    }
                    updateStreamWakeLock(rtc?.hasPeers() == true)
                    notifyState(if (rtc?.hasPeers() == true) "ほかのWeb端末は監視を継続中" else "監視待機中")
                }
            }
        } catch (e: Exception) {
            succeeded = false
            notifyState("命令実行失敗：" + (e.message ?: name))
        }
        if (commandId.isNotBlank()) {
            try {
                api?.call("ack_command", JSONObject()
                    .put("deviceId", prefs.getString("deviceId", ""))
                    .put("deviceSecret", prefs.getString("deviceSecret", ""))
                    .put("commandId", commandId)
                    .put("success", succeeded))
            } catch (_: Exception) {
                notifyState("命令の結果をGASへ送信できませんでした")
            }
        }
    }

    private suspend fun locationLoop() {
        while (scope.isActive) {
            try {
                val connected = rtc?.hasPeers() == true
                val enabled = if (connected) connectedLocationEnabled else idleLocationEnabled
                val interval = (if (connected) connectedInterval else idleInterval) * 1000L
                if (enabled && System.currentTimeMillis() - lastLocationAttempt >= interval) {
                    requestLocation(if (connected) "connected" else "background")
                }
            } catch (_: Exception) {}
            delay(5000)
        }
    }

    private suspend fun requestLocation(mode: String) {
        val granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            notifyState("位置情報の権限がありません")
            return
        }
        val manager = getSystemService(LOCATION_SERVICE) as LocationManager
        val provider = when {
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> {
                notifyState("GPS・ネットワーク位置情報が無効です")
                return
            }
        }
        lastLocationAttempt = System.currentTimeMillis()
        val cached = try { manager.getLastKnownLocation(provider) } catch (_: SecurityException) { null }
        // A two-minute-old cached fix made 10-second tracking appear frozen.
        // Reuse only an almost-current fix; otherwise request a fresh one.
        if (cached != null && System.currentTimeMillis() - cached.time < 5000L) {
            saveLocation(cached, mode)
            return
        }
        try {
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    scope.launch { saveLocation(location, mode) }
                    try { manager.removeUpdates(this) } catch (_: Exception) {}
                }
            }
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            notifyState("位置情報を取得中")
        } catch (e: Exception) {
            notifyState("位置情報取得失敗：設定・権限を確認")
        }
    }

    private suspend fun saveLocation(location: Location, mode: String) {
        val point = JSONObject()
            .put("lat", location.latitude)
            .put("lng", location.longitude)
            .put("accuracy", location.accuracy.toDouble().coerceAtLeast(0.0))
            .put("timestamp", location.time)
            .put("mode", mode)

        // Fast path: deliver the fresh fix directly to every authenticated Web
        // viewer. DataChannel is independent from the GAS history write below.
        val liveDelivered = try {
            rtc?.sendControlToOpenDataChannels(
                JSONObject().put("type", "location_update").put("location", point)
            )
            rtc?.hasOpenControlChannel() == true
        } catch (error: Exception) {
            Log.w("RemoteCameraService", "RTC live location delivery failed", error)
            false
        }

        // Persistence/history remains on GAS + Sheets. A GAS failure must not
        // prevent the location that was already delivered over RTC from showing.
        try {
            api?.call("add_location", JSONObject()
                .put("deviceId", prefs.getString("deviceId", ""))
                .put("deviceSecret", prefs.getString("deviceSecret", ""))
                .put("lat", location.latitude).put("lng", location.longitude)
                .put("accuracy", location.accuracy.toDouble().coerceAtLeast(0.0))
                .put("timestamp", location.time).put("mode", mode))
            lastLocationAttempt = System.currentTimeMillis()
            notifyState(if (liveDelivered) "位置情報をRTCでWebへ配信し、履歴を保存しました。" else "位置情報を履歴へ保存しました。")
        } catch (error: Exception) {
            Log.w("RemoteCameraService", "Location history save failed", error)
            lastLocationAttempt = System.currentTimeMillis()
            notifyState(if (liveDelivered) "位置情報はRTCでWebへ配信しましたが、GAS履歴保存に失敗しました。" else "位置情報のGAS履歴保存に失敗しました。")
        }
    }

    override fun onDestroy() {
        pollJob?.cancel()
        locationJob?.cancel()
        try { rtc?.setTorchEnabled(false) } catch (error: Exception) {
            Log.w("RemoteCameraService", "Could not turn off in-stream torch during service cleanup", error)
        }
        torchEnabled = false
        try { rtc?.dispose() } catch (error: Exception) {
            Log.e("RemoteCameraService", "RTC cleanup failed during service destruction", error)
        }
        rtc = null
        try { updateStreamWakeLock(false) } catch (_: Exception) {}
        try { updateDisplayWakeLock(false) } catch (_: Exception) {}
        try { streamWifiLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        streamWifiLock = null
        prefs.edit().putBoolean("monitoringEnabled", false).putBoolean("androidKeepScreenAwake", false).apply()
        try { getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID) } catch (_: Exception) {}
        scope.cancel()
        super.onDestroy()
    }
}