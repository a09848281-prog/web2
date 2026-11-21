package jp.a09848281.remotecamera

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaRecorder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.*
import org.webrtc.audio.AudioDeviceModule
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.nio.ByteBuffer

class RtcEngine(
    private val context: Context,
    private val api: ApiClient,
    private val deviceId: String,
    private val secret: String,
    private val scope: CoroutineScope,
    private val onState: (String) -> Unit,
    private val onDataChannelMessage: (String, String) -> Unit,
    private val onConnectionState: (String, String) -> Unit,
    private val microphoneMode: String = "ambient"
) {
    private val peers = ConcurrentHashMap<String, PeerConnection>()
    private val videoSenders = ConcurrentHashMap<String, RtpSender>()
    private val controlChannels = ConcurrentHashMap<String, DataChannel>()
    private val disposed = AtomicBoolean(false)
    @Volatile private var noiseSuppressionLevel=70
    @Volatile private var micSensitivity=70
    @Volatile private var micGain=100
    @Volatile private var nightModeEnabled=false
    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: AudioDeviceModule? = null
    private var egl: EglBase? = null
    private var capturer: CameraVideoCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioTrack: AudioTrack? = null
    private var frontCamera = false
    private var selectedCameraId = ""
    private var currentQuality = "720"
    private var currentDataMode = "standard"
    private var currentFps = 24
    private var captureWidth = 1280
    private var captureHeight = 720
    private var captureFps = 24
    @Volatile private var iceServerConfig = JSONArray()

    fun setIceServers(servers: JSONArray?) {
        iceServerConfig = servers ?: JSONArray()
    }

    private fun buildIceServers(): List<PeerConnection.IceServer> {
        val result = mutableListOf<PeerConnection.IceServer>()
        var hasStun = false
        for (index in 0 until iceServerConfig.length()) {
            val item = iceServerConfig.optJSONObject(index) ?: continue
            val rawUrls = item.opt("urls")
            val urls = when (rawUrls) {
                is JSONArray -> (0 until rawUrls.length()).mapNotNull { index ->
                    rawUrls.optString(index).takeIf { it.isNotBlank() }
                }
                is String -> listOf(rawUrls).filter { it.isNotBlank() }
                else -> emptyList()
            }
            val username = item.optString("username", "")
            val credential = item.optString("credential", "")
            urls.filter { it.startsWith("stun:", true) || it.startsWith("turn:", true) || it.startsWith("turns:", true) }
                .forEach { url ->
                    try {
                        val builder = PeerConnection.IceServer.builder(url)
                        if (username.isNotBlank()) builder.setUsername(username)
                        if (credential.isNotBlank()) builder.setPassword(credential)
                        result.add(builder.createIceServer())
                        if (url.startsWith("stun:", true)) hasStun = true
                    } catch (error: Exception) {
                        Log.w("RemoteCameraRTC", "Ignoring invalid ICE server entry", error)
                    }
                }
        }
        if (!hasStun) {
            result.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
        }
        return result
    }
    private data class VideoProfile(
        val width: Int, val height: Int, val fps: Int, val bitrate: Int
    )

    private data class CameraOption(
        val id: String, val facing: String, val focalLength: Float?
    )

    private fun cameraOptions(): List<CameraOption> {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val enumerator = Camera2Enumerator(context)
        return enumerator.deviceNames.mapNotNull { id ->
            try {
                val chars = manager.getCameraCharacteristics(id)
                val facing = when (chars.get(CameraCharacteristics.LENS_FACING)) {
                    CameraCharacteristics.LENS_FACING_BACK -> "back"
                    CameraCharacteristics.LENS_FACING_FRONT -> "front"
                    else -> return@mapNotNull null
                }
                val focal = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                    ?.minOrNull()
                CameraOption(id, facing, focal)
            } catch (e: Exception) {
                Log.w("RemoteCameraRTC", "Could not inspect camera $id", e)
                null
            }
        }.sortedWith(
            compareBy<CameraOption> { if (it.facing == "back") 0 else 1 }
                .thenBy { it.focalLength ?: Float.MAX_VALUE }
        )
    }

    private fun cameraLabel(option: CameraOption, all: List<CameraOption>): String {
        if (option.facing == "front") return "前面カメラ"
        val rear = all.filter { it.facing == "back" }.sortedBy { it.focalLength ?: Float.MAX_VALUE }
        if (rear.size <= 1) return "背面カメラ"
        val focal = option.focalLength ?: return "背面カメラ"
        val shortest = rear.firstNotNullOfOrNull { it.focalLength } ?: focal
        val ratio = focal / shortest.coerceAtLeast(0.01f)
        return when {
            ratio <= 1.15f -> "背面・広角"
            ratio >= 1.65f -> "背面・望遠"
            else -> "背面・標準"
        }
    }

    fun sendCameraCapabilities(sessionId: String) {
        val all = cameraOptions()
        val json = JSONArray()
        all.forEach { option ->
            json.put(JSONObject()
                .put("id", option.id)
                .put("facing", option.facing)
                .put("label", cameraLabel(option, all)))
        }
        sendControl(sessionId, JSONObject()
            .put("type", "camera_capabilities")
            .put("cameras", json)
            .put("selectedCameraId", selectedCameraId))
    }

    private fun profileFor(quality: String, dataMode: String, requestedFps: Int = currentFps): VideoProfile {
        // Profiles are requests; Camera2 may reject unsupported modes and trigger the safe fallback.
        val base = when (quality) {
            "360" -> VideoProfile(640, 360, 15, 350000)
            "480" -> VideoProfile(640, 480, 15, 550000)
            "1080" -> VideoProfile(1920, 1080, 24, 1800000)
            else -> VideoProfile(1280, 720, 24, 950000)
        }
        val modeProfile = when (dataMode) {
            "ultra" -> VideoProfile(640, 360, 10, 280000)
            "save" -> VideoProfile(640, 360, 15, 550000)
            "high" -> base.copy(bitrate = 2400000)
            else -> base
        }
        return modeProfile.copy(fps = requestedFps.coerceIn(10, 60))
    }

    @Synchronized
    private fun ensureMedia() {
        check(!disposed.get()) { "RTC engine is already disposed." }
        if (factory != null && videoTrack != null && audioTrack != null && capturer != null) return
        if (factory == null) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions()
            )
            egl = EglBase.create()
            val audioSourceType = when (microphoneMode) {
                "voice" -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
                else -> MediaRecorder.AudioSource.MIC
            }
            val hardwareAec = microphoneMode == "voice"
            val hardwareNoiseSuppression = microphoneMode == "balanced" || microphoneMode == "voice"
            audioDeviceModule = JavaAudioDeviceModule.builder(context.applicationContext)
                .setAudioSource(audioSourceType)
                .setUseHardwareAcousticEchoCanceler(hardwareAec)
                .setUseHardwareNoiseSuppressor(hardwareNoiseSuppression)
                .createAudioDeviceModule()
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(audioDeviceModule!!)
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
                .createPeerConnectionFactory()
        }
        videoSource = factory!!.createVideoSource(false)
        val enumerator = Camera2Enumerator(context)
        val options = cameraOptions()
        val selected = options.firstOrNull { it.facing == "back" }?.id
            ?: options.firstOrNull()?.id
            ?: error("利用できるカメラがありません。")
        selectedCameraId = selected
        frontCamera = enumerator.isFrontFacing(selected)
        capturer = enumerator.createCapturer(selected, null) ?: error("カメラを開けません。")
        helper = SurfaceTextureHelper.create("RemoteCameraCapture", egl!!.eglBaseContext)
        capturer!!.initialize(helper, context.applicationContext, videoSource!!.capturerObserver)
        val profile = profileFor(currentQuality, currentDataMode, currentFps)
        captureWidth = profile.width
        captureHeight = profile.height
        captureFps = profile.fps
        try {
            capturer!!.startCapture(profile.width, profile.height, profile.fps)
        } catch (first: Exception) {
            Log.w("RemoteCameraRTC", "Preferred camera format failed; retrying conservative VGA mode", first)
            try { capturer?.dispose() } catch (_: Exception) {}
            capturer = enumerator.createCapturer(selected, null) ?: throw first
            capturer!!.initialize(helper, context.applicationContext, videoSource!!.capturerObserver)
            capturer!!.startCapture(640, 480, 15)
            captureWidth = 640
            captureHeight = 480
            captureFps = 15
        }
        videoTrack = factory!!.createVideoTrack("remote-camera-video", videoSource).apply { setEnabled(true) }
        val constraints = MediaConstraints()
        val ambientMode = microphoneMode == "ambient"
        constraints.mandatory.add(MediaConstraints.KeyValuePair(
            "googNoiseSuppression", (microphoneMode != "ambient" && noiseSuppressionLevel > 0).toString()
        ))
        constraints.mandatory.add(MediaConstraints.KeyValuePair(
            "googAutoGainControl", (microphoneMode != "ambient" && micSensitivity > 0).toString()
        ))
        constraints.mandatory.add(MediaConstraints.KeyValuePair(
            "googEchoCancellation", (!ambientMode).toString()
        ))
        audioSource = factory!!.createAudioSource(constraints)
        audioTrack = factory!!.createAudioTrack("remote-camera-audio", audioSource).apply { setEnabled(true); setVolume(micGain / 100.0) }
        onState("カメラ・マイクを起動しました")
    }

    fun handleOffer(sessionId: String, sdp: String) {
        try {
            peers.remove(sessionId)?.let { oldPeer ->
                try { controlChannels.remove(sessionId)?.dispose() } catch (_: Exception) {}
                try { oldPeer.close() } catch (_: Exception) {}
                try { oldPeer.dispose() } catch (_: Exception) {}
            }
            check(peers.size < 3) { "同時に監視できるWeb端末は最大3台です。先に別の接続を切断してください。" }
            ensureMedia()
            val iceServers = buildIceServers()
            val config = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            }
            val answerSent = AtomicBoolean(false)
            lateinit var peer: PeerConnection
            val observer = object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    onState("WebRTC: " + state.name)
                    onConnectionState(sessionId,state.name)
                    if (state == PeerConnection.IceConnectionState.DISCONNECTED) {
                        scope.launch {
                            delay(8000L)
                            if (peers[sessionId] === peer &&
                                peer.iceConnectionState() == PeerConnection.IceConnectionState.DISCONNECTED) {
                                failSession(sessionId, peer, "ICE disconnected for 8 seconds")
                            }
                        }
                    } else if (state == PeerConnection.IceConnectionState.FAILED ||
                        state == PeerConnection.IceConnectionState.CLOSED) {
                        if (peers[sessionId] === peer) failSession(sessionId, peer, "ICE " + state.name)
                    }
                }
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                    if (state == PeerConnection.IceGatheringState.COMPLETE && answerSent.compareAndSet(false, true)) {
                        val local = peer.localDescription
                        if (local != null) scope.launch(Dispatchers.IO) {
                            try {
                                api.call("send_signal", JSONObject()
                                    .put("deviceId", deviceId).put("deviceSecret", secret)
                                    .put("sessionId", sessionId).put("recipient", "viewer")
                                    .put("kind", "answer").put("sdp", local.description))
                            } catch (e: Exception) {
                                onState("応答送信失敗: " + (e.message ?: "通信エラー"))
                            }
                        }
                    }
                }
                override fun onIceCandidate(candidate: IceCandidate) { }
                override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) {}
                override fun onAddStream(stream: MediaStream) {}
                override fun onRemoveStream(stream: MediaStream) {}
                override fun onDataChannel(channel: DataChannel) {
                    try {
                        controlChannels.put(sessionId,channel)?.dispose()
                        channel.registerObserver(object:DataChannel.Observer {
                            override fun onBufferedAmountChange(previousAmount:Long) {}
                            override fun onStateChange() {
                                if(channel.state()==DataChannel.State.OPEN)onConnectionState(sessionId,"DATA_CHANNEL_OPEN")
                            }
                            override fun onMessage(buffer:DataChannel.Buffer) {
                                if(buffer.binary)return
                                try {
                                    val data=buffer.data.slice();val bytes=ByteArray(data.remaining());data.get(bytes)
                                    onDataChannelMessage(sessionId,String(bytes,Charsets.UTF_8))
                                } catch(e:Exception){Log.w("RemoteCameraRTC","Invalid DataChannel message",e)}
                            }
                        })
                        if(channel.state()==DataChannel.State.OPEN)onConnectionState(sessionId,"DATA_CHANNEL_OPEN")
                    } catch(e:Exception){Log.e("RemoteCameraRTC","DataChannel observer failed",e);onState("DataChannel初期化失敗："+(e.message?:"不明"))}
                }
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(receiver: RtpReceiver, streams: Array<MediaStream>) {}
            }
            peer = factory!!.createPeerConnection(config, observer)
                ?: error("PeerConnectionを作成できません。")
            peers[sessionId] = peer
            videoSenders[sessionId] = peer.addTrack(videoTrack, listOf("remote-camera"))
            peer.addTrack(audioTrack, listOf("remote-camera"))
            peer.setRemoteDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    peer.createAnswer(object : SdpObserver {
                        override fun onCreateSuccess(answer: SessionDescription) {
                            peer.setLocalDescription(object : SdpObserver {
                                override fun onSetSuccess() { onState("接続応答を作成中…") }
                                override fun onSetFailure(error: String) { failSession(sessionId, peer, "SDP local description failed: " + error) }
                                override fun onCreateSuccess(desc: SessionDescription) {}
                                override fun onCreateFailure(error: String) { failSession(sessionId, peer, "SDP local description creation failed: " + error) }
                            }, answer)
                        }
                        override fun onCreateFailure(error: String) { failSession(sessionId, peer, "SDP answer creation failed: " + error) }
                        override fun onSetSuccess() {}
                        override fun onSetFailure(error: String) { failSession(sessionId, peer, "SDP remote description callback failed: " + error) }
                    }, MediaConstraints())
                }
                override fun onSetFailure(error: String) { failSession(sessionId, peer, "SDP offer apply failed: " + error) }
                override fun onCreateSuccess(desc: SessionDescription) {}
                override fun onCreateFailure(error: String) { failSession(sessionId, peer, "SDP callback failed: " + error) }
            }, SessionDescription(SessionDescription.Type.OFFER, sdp))
        } catch (e: Exception) {
            Log.e("RemoteCameraRTC", "Offer processing failed; cleaning partial RTC state", e)
            try {
                peers.remove(sessionId)?.let { failedPeer ->
                    try { failedPeer.close() } catch (_: Exception) {}
                    try { failedPeer.dispose() } catch (_: Exception) {}
                }
            } catch (_: Exception) {}
            try { controlChannels.remove(sessionId)?.dispose() } catch (_: Exception) {}
            try { videoSenders.remove(sessionId) } catch (_: Exception) {}
            if (peers.isEmpty()) {
                try { stopMedia() } catch (_: Exception) {}
            }
            onState("WebRTC開始失敗：" + (e.message ?: "不明") + "。アプリの待機は継続します")
            scope.launch(Dispatchers.IO) {
                try {
                    api.call("send_signal", JSONObject()
                        .put("deviceId", deviceId).put("deviceSecret", secret)
                        .put("sessionId", sessionId).put("recipient", "viewer")
                        .put("kind", "error").put("sdp", e.message ?: "RTC error"))
                } catch (_: Exception) {}
            }
        }
    }

    private fun failSession(sessionId: String, peer: PeerConnection, reason: String) {
        if (peers[sessionId] !== peer) return
        peers.remove(sessionId, peer)
        videoSenders.remove(sessionId)
        try { controlChannels.remove(sessionId)?.dispose() } catch (_: Exception) {}
        try { peer.close() } catch (_: Exception) {}
        try { peer.dispose() } catch (_: Exception) {}
        onState("接続セッションを終了しました：" + reason)
        scope.launch(Dispatchers.IO) {
            try {
                api.call("send_signal", JSONObject()
                    .put("deviceId", deviceId).put("deviceSecret", secret)
                    .put("sessionId", sessionId).put("recipient", "viewer")
                    .put("kind", "error").put("sdp", reason.take(500)))
            } catch (error: Exception) {
                Log.w("RemoteCameraRTC", "Could not report failed session", error)
            }
        }
        if (peers.isEmpty()) stopMedia()
    }

    @Synchronized
    fun closeSession(sessionId: String) {
        val peer=peers.remove(sessionId)
        videoSenders.remove(sessionId)
        try{controlChannels.remove(sessionId)?.dispose()}catch(_:Exception){}
        try{peer?.close()}catch(_:Exception){}
        try{peer?.dispose()}catch(_:Exception){}
        if (peers.isEmpty()) stopMedia()
    }

    fun hasPeers():Boolean=peers.isNotEmpty()
    fun peerCount():Int=peers.size
    fun hasOpenControlChannel():Boolean=controlChannels.values.any{it.state()==DataChannel.State.OPEN}
    fun sendControl(sessionId:String,message:JSONObject):Boolean {
        val channel=controlChannels[sessionId]?:return false
        return try{if(channel.state()!=DataChannel.State.OPEN)return false
            channel.send(DataChannel.Buffer(ByteBuffer.wrap(message.toString().toByteArray(Charsets.UTF_8)),false))
        }catch(e:Exception){Log.w("RemoteCameraRTC","DataChannel send failed",e);false}
    }
    fun sendControlToOpenDataChannels(message:JSONObject){controlChannels.keys.toList().forEach{id->sendControl(id,message)}}
    fun setNoiseSuppressionLevel(level:Int){noiseSuppressionLevel=level.coerceIn(0,100);onState("ノイズ抑制要求 "+noiseSuppressionLevel+"%（実効値は端末依存・次回音声初期化時に反映）")}
    fun setMicSensitivity(level:Int){micSensitivity=level.coerceIn(0,100);onState("マイク感度要求 "+micSensitivity+"%（自動ゲインは対応範囲・次回音声初期化時に反映）")}
    fun setMicGain(level:Int){micGain=level.coerceIn(0,100);try{audioTrack?.setVolume(micGain/100.0)}catch(e:Exception){Log.w("RemoteCameraRTC","Mic gain update failed",e)}}
    fun setNightMode(enabled:Boolean){nightModeEnabled=enabled;onState(if(enabled)"夜間モード要求ON（露出制御は端末依存）" else "夜間モードOFF")}

    fun switchCamera(facing: String) {
        val camera = capturer ?: return
        val wantFront = facing == "front"
        if (wantFront == frontCamera) return
        camera.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                frontCamera = isFrontCamera
                selectedCameraId = cameraOptions().firstOrNull { it.facing == facing }?.id ?: selectedCameraId
                onState(if (isFrontCamera) "前面カメラ" else "背面カメラ")
            }
            override fun onCameraSwitchError(error: String) { onState("カメラ切替失敗: $error") }
        })
    }

    @Synchronized
    fun selectCamera(cameraId: String) {
        require(cameraId.isNotBlank()) { "カメラIDが空です。" }
        val all = cameraOptions()
        val option = all.firstOrNull { it.id == cameraId }
            ?: error("この端末では選択したカメラを利用できません。")
        if (cameraId == selectedCameraId) return
        val oldCapturer = capturer ?: error("カメラが起動していません。")
        val currentHelper = helper ?: error("カメラ初期化情報がありません。")
        val currentSource = videoSource ?: error("映像ソースがありません。")
        val enumerator = Camera2Enumerator(context)
        oldCapturer.stopCapture()
        var replacement: CameraVideoCapturer? = null
        try {
            replacement = enumerator.createCapturer(cameraId, null)
                ?: error("選択したカメラを開けません。")
            replacement.initialize(currentHelper, context.applicationContext, currentSource.capturerObserver)
            val profile = profileFor(currentQuality, currentDataMode, currentFps)
            var actualWidth = profile.width
            var actualHeight = profile.height
            var actualFps = profile.fps
            try {
                replacement.startCapture(profile.width, profile.height, profile.fps)
            } catch (first: Exception) {
                Log.w("RemoteCameraRTC", "Selected camera rejected preferred format; using VGA fallback", first)
                try { replacement.stopCapture() } catch (_: Exception) {}
                try { replacement.dispose() } catch (_: Exception) {}
                replacement = enumerator.createCapturer(cameraId, null)
                    ?: throw first
                replacement.initialize(currentHelper, context.applicationContext, currentSource.capturerObserver)
                replacement.startCapture(640, 480, 15)
                actualWidth = 640
                actualHeight = 480
                actualFps = 15
            }
            capturer = replacement
            selectedCameraId = cameraId
            frontCamera = option.facing == "front"
            captureWidth = actualWidth
            captureHeight = actualHeight
            captureFps = actualFps
            try { oldCapturer.dispose() } catch (_: Exception) {}
            onState(cameraLabel(option, all) + "へ切り替えました")
        } catch (e: Exception) {
            try { replacement?.stopCapture() } catch (_: Exception) {}
            try { replacement?.dispose() } catch (_: Exception) {}
            try { oldCapturer.startCapture(captureWidth, captureHeight, captureFps) } catch (restart: Exception) {
                Log.e("RemoteCameraRTC", "Could not restore previous camera after switch failure", restart)
            }
            throw e
        }
    }

    fun setQuality(quality: String, dataMode: String, fps: Int = currentFps) {
        currentQuality = quality
        currentDataMode = dataMode
        currentFps = fps.coerceIn(10, 60)
        val profile = profileFor(currentQuality, currentDataMode, currentFps)
        val camera = capturer
        if (camera != null &&
            (profile.width != captureWidth || profile.height != captureHeight || profile.fps != captureFps)
        ) {
            try {
                camera.changeCaptureFormat(profile.width, profile.height, profile.fps)
                captureWidth = profile.width
                captureHeight = profile.height
                captureFps = profile.fps
            } catch (e: Exception) {
                Log.w("RemoteCameraRTC", "Could not change camera capture format", e)
                onState("画質変更に失敗しました。端末が対応する画質を確認してください。")
            }
        }
        videoSenders.values.forEach { sender ->
            try {
                val params = sender.parameters
                params.encodings.forEach {
                    it.maxBitrateBps = profile.bitrate
                    it.maxFramerate = profile.fps
                }
                if (!sender.setParameters(params)) {
                    Log.w("RemoteCameraRTC", "Video sender rejected quality parameters")
                }
            } catch (e: Exception) {
                Log.w("RemoteCameraRTC", "Could not change video bitrate", e)
            }
        }
    }

    @Synchronized
    private fun stopMedia() {
        try { capturer?.stopCapture() } catch (_: Exception) {}
        try { capturer?.dispose() } catch (_: Exception) {}
        capturer = null
        try { helper?.dispose() } catch (_: Exception) {}
        helper = null
        try { videoTrack?.dispose() } catch (_: Exception) {}
        videoTrack = null
        try { audioTrack?.dispose() } catch (_: Exception) {}
        audioTrack = null
        try { videoSource?.dispose() } catch (_: Exception) {}
        videoSource = null
        try { audioSource?.dispose() } catch (_: Exception) {}
        audioSource = null
    }

    fun dispose(){
        if(!disposed.compareAndSet(false,true))return
        controlChannels.values.forEach{try{it.dispose()}catch(_:Exception){}}
        controlChannels.clear()
        peers.values.forEach{try{it.close()}catch(_:Exception){};try{it.dispose()}catch(_:Exception){}}
        peers.clear()
        videoSenders.clear()
        stopMedia()
        try { factory?.dispose() } catch (_: Exception) {}
        factory = null
        try { audioDeviceModule?.release() } catch (error: Exception) {
            Log.w("RemoteCameraRTC", "AudioDeviceModule release failed", error)
        }
        audioDeviceModule = null
        try { egl?.release() } catch (_: Exception) {}
        egl = null
    }
}