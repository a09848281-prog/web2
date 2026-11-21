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
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
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
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class MonitorService : Service() {
    companion object {
        const val ACTION_START = "jp.a09848281.remotecamera.START"
        const val ACTION_REFRESH_CODE = "jp.a09848281.remotecamera.REFRESH_CODE"
        const val ACTION_STOP = "jp.a09848281.remotecamera.STOP"
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
    private var connectedLocationEnabled = false
    private var idleLocationEnabled = false
    private var connectedInterval = 30L
    private var idleInterval = 300L
    private var currentQuality = "720"
    private var currentDataMode = "standard"
    private var currentFps = 24
    private var lastDevicePollAt = 0L
    private var lastLocationAttempt = 0L
    private var lastCodeRefresh = 0L
    private var pollIntervalSeconds = AppConfig.POLL_SECONDS
    private var trafficBaselineTx = -1L
    private var trafficBaselineRx = -1L
    private var lastTrafficTx = 0L
    private var lastTrafficRx = 0L
    private var lastTrafficAt = 0L
    private var lastNetworkError = ""
    private val apiReady = CompletableDeferred<Unit>()
    private var streamWakeLock: PowerManager.WakeLock? = null
    private var powerSaveActive = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep the foreground service and its notification while the user removes the UI task.
        super.onTaskRemoved(rootIntent)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        val restoredAfterProcessDeath = intent == null && prefs.getBoolean("monitoringEnabled", false)
        if (intent == null && !restoredAfterProcessDeath) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (action == ACTION_STOP) {
            stopMonitoringNow(startId)
            return START_NOT_STICKY
        }
        if (intent != null && action != ACTION_START && action != ACTION_REFRESH_CODE) {
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
        try { startMonitoringForeground() } catch(e:Exception) {
            Log.e("RemoteCameraService","Foreground startup rejected by Android",e)
            prefs.edit().putBoolean("monitoringEnabled",false).apply()
            stopSelf(startId)
            return START_NOT_STICKY
        }

        if (pollJob?.isActive != true) pollJob = scope.launch { pollLoop() }
        if (locationJob?.isActive != true) locationJob = scope.launch { locationLoop() }

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

    private fun startMonitoringForeground() {
        createChannel()
        prefs.edit().putBoolean("monitoringEnabled", true).apply()
        val notification = notification("監視待機中（接続要求を確認しています）")
        if (Build.VERSION.SDK_INT >= 29) {
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            val hasLocation = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED
            if(hasLocation) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            startForeground(NOTIFICATION_ID,notification,types)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Remote Camera", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "遠隔監視の待機・接続状態を表示します。" }
            )
        }
    }

    private fun stopActionPendingIntent(): PendingIntent {
        val intent = Intent(this, MonitorService::class.java).setAction(ACTION_STOP)
        return PendingIntent.getService(
            this, 2, intent,
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
        rtc?.dispose()
        rtc = null
        updateStreamWakeLock(false)
        prefs.edit().putBoolean("monitoringEnabled", false).apply()
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        stopSelf(startId)
    }

    private fun notifyState(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private suspend fun pollLoop() {
        try {
            api = ApiClient(gasUrl)
            ensureDevice()
            if (!apiReady.isCompleted) apiReady.complete(Unit)
            while (scope.isActive) {
                val controlOpen = rtc?.hasOpenControlChannel() == true
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
                    sendTelemetry()
                    // Existing viewers use DataChannel directly. Keep only the
                    // selected low-frequency GAS check while a slot remains so
                    // a second/third paired browser can establish its own RTC session.
                    if ((rtc?.peerCount() ?: 0) >= 3) {
                        delay(2000L)
                        continue
                    }
                    val elapsed = System.currentTimeMillis() - lastDevicePollAt
                    val untilNextPoll = pollIntervalSeconds * 1000L - elapsed
                    if (untilNextPoll > 0L) {
                        delay(minOf(2000L, untilNextPoll))
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
                        val signals = response.optJSONArray("signals") ?: JSONArray()
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
                                            rtc = RtcEngine(this,currentApi,deviceId,secret,scope,::notifyState,
                                                onDataChannelMessage=::handleDataChannelMessage,
                                                onConnectionState=::onRtcConnectionState)
                                        }
                                        rtc?.setIceServers(response.optJSONArray("iceServers"))
                                        rtc?.setNoiseSuppressionLevel(prefs.getInt("micNoise", 70))
                                        rtc?.setMicSensitivity(prefs.getInt("micSensitivity", 70))
                                        rtc?.setMicGain(prefs.getInt("micGain", 100))
                                        rtc?.setNightMode(prefs.getBoolean("nightMode", false))
                                        rtc?.handleOffer(session, signal.optString("sdp"))
                                        rtc?.setQuality(currentQuality, currentDataMode, currentFps)
                                        notifyState("接続要求を処理しています")
                                    } catch (e: Exception) {
                                        Log.e("RemoteCameraService", "Offer handling failed; keep foreground service alive", e)
                                        notifyState("接続開始に失敗しました：" + (e.message ?: "詳細不明") + "。待機は継続します")
                                    }
                                }
                                "bye" -> {
                                    rtc?.closeSession(signal.optString("sessionId"))
                                    updateStreamWakeLock(rtc?.hasPeers() == true)
                                    notifyState("Web側から切断要求を受信しました")
                                }
                            }
                        }
                        val commands = response.optJSONArray("commands") ?: JSONArray()
                        for (i in 0 until commands.length()) processCommand(commands.optJSONObject(i) ?: continue)
                        // Advance only after this poll's signals and commands have been handed to the handlers.
                        afterSeq = maxOf(afterSeq, response.optInt("latestSeq", afterSeq))
                        prefs.edit().putInt("afterSeq", afterSeq).apply()
                        notifyState(if (rtc?.hasPeers() == true) "監視中・接続済み" else "監視待機中")
                    }
                } catch (e: Exception) {
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
                delay(if (rtc?.hasOpenControlChannel()==true) 2000L else pollIntervalSeconds*1000L)
            }
        } catch (e: Exception) {
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
                updateStreamWakeLock(true)
                if (trafficBaselineTx < 0L || trafficBaselineRx < 0L) {
                    trafficBaselineTx=TrafficStats.getUidTxBytes(Process.myUid())
                    trafficBaselineRx=TrafficStats.getUidRxBytes(Process.myUid())
                    lastTrafficTx=0L;lastTrafficRx=0L;lastTrafficAt=System.currentTimeMillis()
                }
                notifyState("監視中・DataChannel直接通信")
                rtc?.sendCameraCapabilities(sessionId)
                if (lastNetworkError.isNotBlank()) {
                    val reason = lastNetworkError
                    scope.launch {
                        delay(250L)
                        sendNetworkDiagnostic(sessionId, reason)
                    }
                }
            }
            "FAILED","CLOSED","DISCONNECTED" -> {
                lastNetworkError="WebRTC ICE状態: "+state
                notifyState("RTC "+state+"：再接続を待機します")
                scope.launch {
                    delay(8500L)
                    updateStreamWakeLock(rtc?.hasPeers() == true)
                }
            }
        }
    }
    private fun handleDataChannelMessage(sessionId:String,raw:String) {
        scope.launch {
            var requestId=""
            try {
                val req=JSONObject(raw)
                if(req.optString("type")!="command")return@launch
                requestId=req.optString("requestId")
                val name=req.optString("command")
                val payload=req.optJSONObject("payload")?:JSONObject()
                val result=executeDataChannelCommand(sessionId,name,payload)
                rtc?.sendControl(sessionId,JSONObject().put("type","ack").put("requestId",requestId).put("ok",true).put("message",result))
                if(name=="disconnect"){
                    delay(150L)
                    rtc?.closeSession(sessionId)
                    updateStreamWakeLock(rtc?.hasPeers() == true)
                }
            } catch(e:Exception) {
                try{rtc?.sendControl(sessionId,JSONObject().put("type","ack").put("requestId",requestId).put("ok",false).put("message",e.message?:"命令を適用できませんでした"))}catch(_:Exception){}
                lastNetworkError="DataChannel命令エラー: "+(e.message?:"不明")
                sendNetworkDiagnostic(sessionId,lastNetworkError)
                notifyState("DataChannel命令エラー："+(e.message?:"不明"))
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
            }
            "torch" -> setTorch(payload.optBoolean("enabled",false))
            "volume","speaker_volume" -> {
                val pct=payload.optInt("percent",70).coerceIn(0,100)
                val audio=getSystemService(AUDIO_SERVICE) as AudioManager
                val stream=AudioManager.STREAM_VOICE_CALL
                audio.setStreamVolume(stream,(audio.getStreamMaxVolume(stream)*pct/100.0).toInt(),0)
            }
            "adaptive_quality" -> {
                if (!powerSaveActive) applyAdaptiveQuality(payload)
            }
            "quality","data_mode","settings_update" -> {
                applyVideoSettings(payload)
                rtc?.setNoiseSuppressionLevel(payload.optInt("micNoise",prefs.getInt("micNoise",70)))
                rtc?.setMicSensitivity(payload.optInt("micSensitivity",prefs.getInt("micSensitivity",70)))
                rtc?.setMicGain(payload.optInt("micGain",prefs.getInt("micGain",100)))
                val pct=payload.optInt("speakerVolume",70).coerceIn(0,100)
                val audio=getSystemService(AUDIO_SERVICE) as AudioManager
                val stream=AudioManager.STREAM_VOICE_CALL
                audio.setStreamVolume(stream,(audio.getStreamMaxVolume(stream)*pct/100.0).toInt(),0)
                rtc?.setNightMode(payload.optBoolean("nightMode",false))
                prefs.edit().putString("quality",currentQuality).putString("dataMode",currentDataMode)
                    .putInt("fps",currentFps)
                    .putString("aspectRatio",payload.optString("aspectRatio","16:9"))
                    .putInt("micNoise",payload.optInt("micNoise",70).coerceIn(0,100))
                    .putInt("micSensitivity",payload.optInt("micSensitivity",70).coerceIn(0,100))
                    .putInt("micGain",payload.optInt("micGain",100).coerceIn(0,100))
                    .putInt("speakerVolume",pct)
                    .putBoolean("nightMode",payload.optBoolean("nightMode",false)).apply()
            }
            "mic_noise" -> rtc?.setNoiseSuppressionLevel(payload.optInt("strength",70))
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
    private fun updateStreamWakeLock(active: Boolean) {
        try {
            val power = getSystemService(POWER_SERVICE) as PowerManager
            if (active) {
                var lock = streamWakeLock
                if (lock == null) {
                    lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, packageName + ":remote-camera-stream")
                    lock.setReferenceCounted(false)
                    streamWakeLock = lock
                }
                if (!lock.isHeld) lock.acquire()
            } else {
                streamWakeLock?.let { if (it.isHeld) it.release() }
            }
        } catch (error: Exception) {
            Log.w("RemoteCameraService", "Could not update stream wake lock", error)
        }
    }

    private fun setTorch(enabled:Boolean) {
        val manager=getSystemService(CAMERA_SERVICE) as CameraManager
        val backId=manager.cameraIdList.firstOrNull { id ->
            val chars=manager.getCameraCharacteristics(id)
            chars.get(CameraCharacteristics.LENS_FACING)==CameraCharacteristics.LENS_FACING_BACK &&
                chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE)==true
        } ?: error("ライト対応の背面カメラが見つかりません。")
        manager.setTorchMode(backId,enabled)
    }

    private fun sendNetworkDiagnostic(sessionId:String,reason:String=lastNetworkError) {
        val data=networkInfo().put("androidVersion",Build.VERSION.RELEASE).put("apiLevel",Build.VERSION.SDK_INT)
            .put("deviceModel",Build.MODEL?:"Android").put("rtcControlChannelOpen",rtc?.hasOpenControlChannel()==true)
            .put("recentError",reason)
        rtc?.sendControl(sessionId,JSONObject().put("type","network_diagnostic").put("data",data))
        lastNetworkError=""
    }
    private fun sendTelemetry() {
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
        val data=JSONObject().put("type","telemetry").put("txBytesSinceConnect",tx).put("rxBytesSinceConnect",rx)
            .put("txBytesPerSecond",txSpeed).put("rxBytesPerSecond",rxSpeed).put("batteryPercent",percent)
            .put("batteryTempC",temp).put("thermalStatus",thermal).put("network",networkInfo())
        rtc?.sendControlToOpenDataChannels(data)
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
        )
        val requestedDataMode = settings.optString(
            "dataMode", prefs.getString("requestedDataMode", "standard") ?: "standard"
        )
        val previousQuality = prefs.getString("requestedQuality", "720") ?: "720"
        val previousDataMode = prefs.getString("requestedDataMode", "standard") ?: "standard"
        val requestChanged = requestedQuality != previousQuality || requestedDataMode != previousDataMode
        val requestedFps = settings.optInt("fps", prefs.getInt("fps", 24)).coerceIn(10, 60)
        val editor = prefs.edit()
            .putString("requestedQuality", requestedQuality)
            .putString("requestedDataMode", requestedDataMode)
            .putInt("fps", requestedFps)
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
        val automatic = requestedQuality == "auto" || requestedDataMode == "auto"
        currentFps = if (automatic) {
            prefs.getInt("adaptiveFps", requestedFps).coerceIn(10, 60)
        } else requestedFps
        if (powerSaveActive) {
            currentQuality = "360"
            currentDataMode = "ultra"
            currentFps = 10
        }
        rtc?.setQuality(currentQuality, currentDataMode, currentFps)
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
        rtc?.setQuality(currentQuality, currentDataMode, currentFps)
    }

    private fun applySettings(settings: JSONObject) {
        connectedLocationEnabled = settings.optBoolean("connectedLocationEnabled", false)
        idleLocationEnabled = settings.optBoolean("idleLocationEnabled", false)
        connectedInterval = settings.optLong("connectedInterval", 30).coerceIn(10, 3600)
        idleInterval = settings.optLong("idleInterval", 300).coerceIn(10, 3600)
        applyVideoSettings(settings)
        val micNoise = settings.optInt("micNoise", prefs.getInt("micNoise", 70)).coerceIn(0, 100)
        val micSensitivity = settings.optInt("micSensitivity", prefs.getInt("micSensitivity", 70)).coerceIn(0, 100)
        val micGain = settings.optInt("micGain", prefs.getInt("micGain", 100)).coerceIn(0, 100)
        val speakerVolume = settings.optInt("speakerVolume", prefs.getInt("speakerVolume", 70)).coerceIn(0, 100)
        val nightMode = settings.optBoolean("nightMode", prefs.getBoolean("nightMode", false))
        prefs.edit().putInt("micNoise", micNoise)
            .putInt("micSensitivity", micSensitivity).putInt("micGain", micGain)
            .putInt("speakerVolume", speakerVolume).putBoolean("nightMode", nightMode).apply()
        rtc?.setNoiseSuppressionLevel(micNoise)
        rtc?.setMicSensitivity(micSensitivity)
        rtc?.setMicGain(micGain)
        rtc?.setNightMode(nightMode)
        try {
            val audio = getSystemService(AUDIO_SERVICE) as AudioManager
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
            audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL, (max * speakerVolume / 100.0).toInt(), 0)
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
                    val stream = AudioManager.STREAM_VOICE_CALL
                    val max = audio.getStreamMaxVolume(stream)
                    audio.setStreamVolume(stream, (max * percent / 100.0).toInt(), 0)
                }
                "adaptive_quality" -> applyAdaptiveQuality(payload)
                "quality", "data_mode" -> applyVideoSettings(payload)
                "disconnect" -> {
                    rtc?.dispose()
                    rtc = null
                    updateStreamWakeLock(false)
                    notifyState("監視待機中")
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
        if (cached != null && System.currentTimeMillis() - cached.time < 120000L) {
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
        try {
            api?.call("add_location", JSONObject()
                .put("deviceId", prefs.getString("deviceId", ""))
                .put("deviceSecret", prefs.getString("deviceSecret", ""))
                .put("lat", location.latitude).put("lng", location.longitude)
                .put("accuracy", location.accuracy.toDouble()).put("timestamp", location.time)
                .put("mode", mode))
            lastLocationAttempt = System.currentTimeMillis()
            notifyState("位置情報を保存しました")
        } catch (_: Exception) {
            notifyState("位置情報送信失敗")
        }
    }

    override fun onDestroy() {
        pollJob?.cancel()
        locationJob?.cancel()
        rtc?.dispose()
        rtc = null
        try { updateStreamWakeLock(false) } catch (_: Exception) {}
        scope.cancel()
        super.onDestroy()
    }
}