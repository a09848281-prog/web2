package jp.a09848281.remotecamera

import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.MediaRecorder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.nio.ByteBuffer
import kotlin.math.roundToInt

class RtcEngine(
    private val context: Context,
    private val api: ApiClient,
    private val deviceId: String,
    private val secret: String,
    private val scope: CoroutineScope,
    private val onState: (String) -> Unit,
    private val onDataChannelMessage: (String, String) -> Unit,
    private val onConnectionState: (String, String) -> Unit,
    private val microphoneMode: String = "balanced",
    private val captureAspectRatio: String = "16:9"
) {
    companion object {
        private val initializationLock = Any()
        @Volatile private var webRtcInitialized = false

        private fun ensureWebRtcInitialized(context: Context) {
            if (webRtcInitialized) return
            synchronized(initializationLock) {
                if (webRtcInitialized) return
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                        .createInitializationOptions()
                )
                webRtcInitialized = true
            }
        }
    }

    private val peers = ConcurrentHashMap<String, PeerConnection>()
    private val videoSenders = ConcurrentHashMap<String, RtpSender>()
    private val controlChannels = ConcurrentHashMap<String, DataChannel>()
    private val disposed = AtomicBoolean(false)
    @Volatile private var micSensitivity=70
    @Volatile private var micGain=100
    @Volatile private var nightModeEnabled=false
    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
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
    private var currentAspectRatio = captureAspectRatio.takeIf { it in setOf("16:9", "4:3", "1:1", "9:16", "original") } ?: "original"
    private var captureWidth = 1280
    private var captureHeight = 720
    private var captureFps = 24
    @Volatile private var torchRequested = false
    @Volatile private var cameraEnabled = true
    @Volatile private var microphoneEnabled = true
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
        val id: String, val facing: String, val focalLength: Float?, val horizontalFovDegrees: Float?
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
                val focal = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull()
                val sensorWidthMm = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)?.width
                val horizontalFov = if (sensorWidthMm != null && focal != null && focal > 0f) {
                    Math.toDegrees(2.0 * kotlin.math.atan(sensorWidthMm.toDouble() / (2.0 * focal.toDouble()))).toFloat()
                } else null
                CameraOption(id, facing, focal, horizontalFov)
            } catch (e: Exception) {
                Log.w("RemoteCameraRTC", "Could not inspect camera $id", e)
                null
            }
        }.sortedWith(
            compareBy<CameraOption> { if (it.facing == "back") 0 else 1 }
                .thenByDescending { it.horizontalFovDegrees ?: Float.NEGATIVE_INFINITY }
                .thenBy { it.focalLength ?: Float.MAX_VALUE }
        )
    }

    private fun cameraLabel(option: CameraOption, all: List<CameraOption>): String {
        if (option.facing == "front") return "前面カメラ"
        val rear = all.filter { it.facing == "back" }.sortedBy { it.focalLength ?: Float.MAX_VALUE }
        if (rear.size <= 1) return "背面カメラ"
        val focal = option.focalLength ?: return "背面カメラ"
        val shortest = rear.mapNotNull { it.focalLength }.minOrNull() ?: focal
        val ratio = focal / shortest.coerceAtLeast(0.01f)
        return when {
            (option.horizontalFovDegrees ?: 0f) >= 90f -> "背面・超広角"
            (option.horizontalFovDegrees ?: 0f) >= 72f -> "背面・広角"
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
                .put("label", cameraLabel(option, all))
                .put("focalLengthMm", option.focalLength?.toDouble() ?: JSONObject.NULL)
                .put("horizontalFovDegrees", option.horizontalFovDegrees?.toDouble() ?: JSONObject.NULL))
        }
        sendControl(sessionId, JSONObject()
            .put("type", "camera_capabilities")
            .put("cameras", json)
            .put("selectedCameraId", selectedCameraId))
    }

    private fun cameraNativeAspectRatio(cameraId: String): Double {
        return try {
            val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val characteristics = manager.getCameraCharacteristics(cameraId)
            val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val largest = map?.getOutputSizes(SurfaceTexture::class.java)
                ?.maxByOrNull { it.width.toLong() * it.height.toLong() }
            val sensorSize = characteristics.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
            val width = largest?.width ?: sensorSize?.width ?: 4
            val height = largest?.height ?: sensorSize?.height ?: 3
            val ratio = maxOf(width, height).toDouble() / minOf(width, height).coerceAtLeast(1)
            if (ratio.isFinite() && ratio in 1.0..2.5) ratio else 4.0 / 3.0
        } catch (error: Exception) {
            Log.w("RemoteCameraRTC", "Could not read native camera aspect ratio", error)
            4.0 / 3.0
        }
    }

    private fun profileFor(
        quality: String,
        dataMode: String,
        requestedFps: Int = currentFps,
        cameraId: String = selectedCameraId
    ): VideoProfile {
        val tier = when (quality) { "360" -> 360; "480" -> 480; "1080" -> 1080; else -> 720 }
        val dimensions = when (currentAspectRatio) {
            "4:3" -> when (tier) {
                360 -> 640 to 480
                480 -> 640 to 480
                1080 -> 1440 to 1080
                else -> 960 to 720
            }
            "1:1" -> tier to tier
            "9:16" -> when (tier) {
                360 -> 360 to 640
                480 -> 480 to 854
                1080 -> 1080 to 1920
                else -> 720 to 1280
            }
            "original" -> {
                val ratio = cameraNativeAspectRatio(cameraId)
                (tier * ratio).roundToInt().coerceAtLeast(tier) to tier
            }
            else -> when (tier) {
                360 -> 640 to 360
                480 -> 854 to 480
                1080 -> 1920 to 1080
                else -> 1280 to 720
            }
        }
        val resolutionBitrate = when (tier) {
            360 -> 650000
            480 -> 1000000
            1080 -> 3800000
            else -> 1900000
        }
        val fpsScale = (requestedFps.coerceIn(10, 60) / 30.0).coerceAtLeast(0.65)
        val baseBitrate = (resolutionBitrate * fpsScale).toInt().coerceIn(350000, 6500000)
        val base = VideoProfile(dimensions.first, dimensions.second, requestedFps.coerceIn(10, 60), baseBitrate)
        return when (dataMode) {
            "ultra" -> base.copy(fps = minOf(base.fps, 10), bitrate = 350000)
            "save" -> base.copy(fps = minOf(base.fps, 15), bitrate = 650000)
            "high" -> base.copy(bitrate = minOf(3500000, (base.bitrate * 1.25).toInt()))
            "auto" -> base.copy(fps = minOf(base.fps, 20), bitrate = minOf(base.bitrate, 1200000))
            else -> base
        }
    }

    private data class StartedCapture(
        val capturer: CameraVideoCapturer,
        val width: Int,
        val height: Int,
        val fps: Int
    )

    private fun fallbackCaptureSizes(cameraId: String): List<Pair<Int, Int>> {
        val staticSizes = when (currentAspectRatio) {
            "4:3" -> listOf(1920 to 1440, 1600 to 1200, 1280 to 960, 960 to 720, 640 to 480)
            "1:1" -> listOf(1440 to 1440, 1080 to 1080, 720 to 720, 480 to 480, 360 to 360)
            "9:16" -> listOf(1080 to 1920, 720 to 1280, 480 to 854, 360 to 640)
            "original" -> {
                val ratio = cameraNativeAspectRatio(cameraId)
                listOf(1440, 1080, 960, 720, 640, 480, 360).map { height ->
                    (height * ratio).roundToInt() to height
                }
            }
            else -> listOf(1920 to 1080, 1600 to 900, 1280 to 720, 960 to 540, 640 to 360)
        }
        val supported = try {
            val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            manager.getCameraCharacteristics(cameraId)
                .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(SurfaceTexture::class.java)
                ?.map { it.width to it.height }
                ?: emptyList()
        } catch (error: Exception) {
            Log.w("RemoteCameraRTC", "Could not list camera output sizes", error)
            emptyList()
        }
        return if (supported.isNotEmpty()) supported.distinct() else staticSizes
    }

    private fun chooseSupportedFps(cameraId: String, requestedFps: Int): Int {
        val ranges = try {
            val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            manager.getCameraCharacteristics(cameraId)
                .get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                ?.toList().orEmpty()
        } catch (error: Exception) {
            Log.w("RemoteCameraRTC", "Could not list camera FPS ranges", error)
            emptyList()
        }
        if (ranges.isEmpty()) return requestedFps
        val unit = if (ranges.any { it.upper > 1000 || it.lower > 1000 }) 1000 else 1
        val normalized = ranges.map { (it.lower / unit).coerceAtLeast(1) to (it.upper / unit).coerceAtLeast(1) }
            .filter { it.second >= 10 }
        if (normalized.isEmpty()) return requestedFps
        val exact = normalized.firstOrNull { it.first == requestedFps && it.second == requestedFps }
        if (exact != null) return requestedFps
        val containing = normalized.filter { requestedFps in it.first..it.second }
        if (containing.isNotEmpty()) return requestedFps
        return normalized.map { maxOf(it.first, it.second) }
            .filter { it in 10..requestedFps }
            .maxOrNull() ?: normalized.minOf { minOf(it.first, it.second) }
    }

    private fun startCaptureWithFallback(
        enumerator: Camera2Enumerator,
        cameraId: String,
        surfaceHelper: SurfaceTextureHelper,
        source: VideoSource,
        requested: VideoProfile
    ): StartedCapture {
        val requestedSize = requested.width to requested.height
        val requestedPixels = requested.width.toLong() * requested.height.toLong()
        val requestedRatio = requested.width.toDouble() / requested.height.toDouble()
        val supportedSizes = fallbackCaptureSizes(cameraId)
        val sameRatioSizes = supportedSizes.filter { size ->
            kotlin.math.abs(size.first.toDouble() / size.second.toDouble() - requestedRatio) < 0.035
        }
        val underRequested = sameRatioSizes.filter { size ->
            size.first.toLong() * size.second.toLong() <= requestedPixels
        }.sortedByDescending { it.first.toLong() * it.second.toLong() }
        val selectedSize = when {
            requestedSize in supportedSizes -> requestedSize
            underRequested.isNotEmpty() -> underRequested.first()
            sameRatioSizes.isNotEmpty() -> sameRatioSizes.minBy {
                kotlin.math.abs(it.first.toLong() * it.second.toLong() - requestedPixels)
            }
            supportedSizes.isNotEmpty() -> supportedSizes.minBy {
                kotlin.math.abs(it.first.toLong() * it.second.toLong() - requestedPixels)
            }
            else -> requestedSize
        }
        val sizes = (listOf(selectedSize) + underRequested.filter { it != selectedSize }).distinct()
        val effectiveFps = chooseSupportedFps(cameraId, requested.fps)
        val fpsOptions = (listOf(effectiveFps, 60, 55, 50, 45, 40, 30, 24, 20, 15, 10))
            .distinct().filter { it in 10..effectiveFps }.sortedDescending()
        var lastError: Exception? = null
        for ((width, height) in sizes) {
            for (fps in fpsOptions) {
                var candidate: CameraVideoCapturer? = null
                try {
                    candidate = RemoteTorchCamera2Capturer(context, cameraId, null)
                    candidate.initialize(surfaceHelper, context.applicationContext, source.capturerObserver)
                    candidate.startCapture(width, height, fps)
                    if (torchRequested) {
                        try {
                            (candidate as? TorchCaptureControl)?.setTorchEnabled(true)
                        } catch (torchError: Exception) {
                            torchRequested = false
                            Log.w("RemoteCameraRTC", "Torch could not be restored on the selected camera", torchError)
                        }
                    }
                    Log.i("RemoteCameraRTC", "Camera capture requested: ${width}x${height}@${fps}; supported output selected.")
                    return StartedCapture(candidate, width, height, fps)
                } catch (error: Exception) {
                    lastError = error
                    Log.w("RemoteCameraRTC", "Camera format failed: ${width}x${height}@${fps}", error)
                    try { candidate?.stopCapture() } catch (_: Exception) {}
                    try { candidate?.dispose() } catch (_: Exception) {}
                }
            }
        }
        throw lastError ?: IllegalStateException("対応する撮影形式がありません。")
    }

    @Synchronized
    private fun ensureMedia() {
        check(!disposed.get()) { "RTC engine is already disposed." }
        if (factory != null && videoTrack != null && audioTrack != null && capturer != null) return
        try {
            if (factory == null) {
                ensureWebRtcInitialized(context.applicationContext)
                egl = EglBase.create()
                try {
                    (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode = AudioManager.MODE_NORMAL
                } catch (error: Exception) {
                    Log.w("RemoteCameraRTC", "Could not set normal audio mode", error)
                }
                val audioSourceType = when (microphoneMode) {
                    "voice" -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
                    else -> MediaRecorder.AudioSource.MIC
                }
                val hardwareAec = microphoneMode == "voice"
                audioDeviceModule = JavaAudioDeviceModule.builder(context.applicationContext)
                    .setAudioSource(audioSourceType)
                    .setUseHardwareAcousticEchoCanceler(hardwareAec)
                    .setUseHardwareNoiseSuppressor(false)
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
            helper = SurfaceTextureHelper.create("RemoteCameraCapture", egl!!.eglBaseContext)
            val profile = profileFor(currentQuality, currentDataMode, currentFps)
            val started = startCaptureWithFallback(
                enumerator, selected, helper!!, videoSource!!, profile
            )
            capturer = started.capturer
            captureWidth = started.width
            captureHeight = started.height
            captureFps = started.fps
            videoTrack = factory!!.createVideoTrack("remote-camera-video", videoSource).apply { setEnabled(true) }
            val constraints = MediaConstraints()
            val ambientMode = microphoneMode == "ambient"
            constraints.mandatory.add(MediaConstraints.KeyValuePair(
                "googNoiseSuppression", "false"
            ))
            constraints.mandatory.add(MediaConstraints.KeyValuePair(
                "googAutoGainControl", (microphoneMode != "ambient" && micSensitivity > 0).toString()
            ))
            constraints.mandatory.add(MediaConstraints.KeyValuePair(
                "googEchoCancellation", (!ambientMode).toString()
            ))
            audioSource = factory!!.createAudioSource(constraints)
            audioTrack = factory!!.createAudioTrack("remote-camera-audio", audioSource)
                .apply { setEnabled(true); setVolume(micGain / 100.0) }
            onState("カメラ・マイクを起動しました")
        } catch (error: Exception) {
            Log.e("RemoteCameraRTC", "Media startup failed; releasing partial resources", error)
            stopMedia()
            try { factory?.dispose() } catch (_: Exception) {}
            factory = null
            try { audioDeviceModule?.release() } catch (_: Exception) {}
            audioDeviceModule = null
            try { egl?.release() } catch (_: Exception) {}
            egl = null
            throw error
        }
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
                    // Ignore late CLOSED callbacks after this viewer has already been removed.
                    if (state == PeerConnection.IceConnectionState.CLOSED && peers[sessionId] !== peer) return
                    onState("WebRTC: " + state.name)
                    onConnectionState(sessionId,state.name)
                    if (state == PeerConnection.IceConnectionState.DISCONNECTED) {
                        scope.launch {
                            delay(5000L)
                            if (peers[sessionId] === peer &&
                                peer.iceConnectionState() == PeerConnection.IceConnectionState.DISCONNECTED) {
                                failSession(sessionId, peer, "ICE disconnected for 5 seconds")
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
                                if (controlChannels[sessionId] !== channel) return
                                when (channel.state()) {
                                    DataChannel.State.OPEN -> onConnectionState(sessionId, "DATA_CHANNEL_OPEN")
                                    DataChannel.State.CLOSED -> onConnectionState(sessionId, "DATA_CHANNEL_CLOSED")
                                    else -> Unit
                                }
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
        onConnectionState(sessionId, "SESSION_REMOVED")
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
    fun hasSession(sessionId: String): Boolean = peers.containsKey(sessionId)
    fun iceConnectionState(sessionId: String): String? = peers[sessionId]?.iceConnectionState()?.name

    fun currentCameraFacing(): String = if (frontCamera) "前面" else "背面"
    fun currentCameraId(): String = selectedCameraId
    fun hasOpenControlChannel():Boolean=controlChannels.values.any{it.state()==DataChannel.State.OPEN}
    fun sendControl(sessionId:String,message:JSONObject):Boolean {
        val channel=controlChannels[sessionId]?:return false
        return try{if(channel.state()!=DataChannel.State.OPEN)return false
            channel.send(DataChannel.Buffer(ByteBuffer.wrap(message.toString().toByteArray(Charsets.UTF_8)),false))
        }catch(e:Exception){Log.w("RemoteCameraRTC","DataChannel send failed",e);false}
    }
    fun sendControlToOpenDataChannels(message:JSONObject){controlChannels.keys.toList().forEach{id->sendControl(id,message)}}
    fun setMicSensitivity(level:Int){micSensitivity=level.coerceIn(0,100);onState("マイク感度要求 "+micSensitivity+"%（自動ゲインは対応範囲・次回音声初期化時に反映）")}
    fun setMicGain(level:Int){micGain=level.coerceIn(0,100);try{audioTrack?.setVolume(micGain/100.0)}catch(e:Exception){Log.w("RemoteCameraRTC","Mic gain update failed",e)}}
    fun setNightMode(enabled:Boolean){nightModeEnabled=enabled;onState(if(enabled)"夜間モード要求ON（露出制御は端末依存）" else "夜間モードOFF")}

    @Synchronized
    @Synchronized
    fun setCameraEnabled(enabled: Boolean) {
        if (cameraEnabled == enabled) return
        val oldCamera = capturer ?: error("カメラが起動していません。")
        val track = videoTrack ?: error("映像トラックがありません。")
        if (enabled) {
            val currentHelper = helper ?: error("カメラ初期化情報がありません。")
            val currentSource = videoSource ?: error("映像ソースがありません。")
            val profile = profileFor(currentQuality, currentDataMode, currentFps, selectedCameraId)
            val started = try {
                startCaptureWithFallback(
                    Camera2Enumerator(context), selectedCameraId, currentHelper, currentSource, profile
                )
            } catch (error: Exception) {
                // Keep the previous stopped capturer recoverable if the requested profile
                // cannot be opened; do not leave the Android camera toggle permanently stuck OFF.
                try {
                    oldCamera.startCapture(captureWidth, captureHeight, captureFps)
                    track.setEnabled(true)
                    cameraEnabled = true
                    onState("新しい撮影設定を開けなかったため、以前の撮影形式でカメラを再開しました。")
                } catch (restoreError: Exception) {
                    Log.e("RemoteCameraRTC", "Could not restore camera after failed re-enable", restoreError)
                }
                throw error
            }
            capturer = started.capturer
            captureWidth = started.width
            captureHeight = started.height
            captureFps = started.fps
            try { oldCamera.dispose() } catch (error: Exception) {
                Log.w("RemoteCameraRTC", "Stopped camera capturer disposal failed", error)
            }
            track.setEnabled(true)
            cameraEnabled = true
        } else {
            if (torchRequested) {
                try { (oldCamera as? TorchCaptureControl)?.setTorchEnabled(false) } catch (error: Exception) {
                    Log.w("RemoteCameraRTC", "Torch OFF before camera pause failed", error)
                }
                torchRequested = false
            }
            track.setEnabled(false)
            oldCamera.stopCapture()
            cameraEnabled = false
        }
    }

    @Synchronized
    fun setMicrophoneEnabled(enabled: Boolean) {
        val track = audioTrack ?: error("マイク音声トラックがありません。")
        track.setEnabled(enabled)
        microphoneEnabled = enabled
    }

    fun isCameraEnabled(): Boolean = cameraEnabled
    fun isMicrophoneEnabled(): Boolean = microphoneEnabled
    @Synchronized
    fun setTorchEnabled(enabled: Boolean) {
        val camera = capturer ?: error("カメラ映像が起動していません。")
        if (!cameraEnabled) error("カメラがOFFの間はライトを操作できません。")
        if (enabled && frontCamera) error("ライトは背面カメラ使用中のみ利用できます。")
        val control = camera as? TorchCaptureControl
            ?: error("このカメラはCamera2ライト制御に対応していません。")
        control.setTorchEnabled(enabled)
        torchRequested = enabled
        onState(if (enabled) "Androidライト ON（映像と同じCamera2セッション）" else "Androidライト OFF")
    }

    fun isTorchEnabled(): Boolean = (capturer as? TorchCaptureControl)?.isTorchEnabled() == true
    fun hasTorchSupport(): Boolean = cameraEnabled && (capturer as? TorchCaptureControl)?.hasTorchSupport() == true

    fun captureInfo(): JSONObject = JSONObject()
        .put("width", captureWidth)
        .put("height", captureHeight)
        .put("fps", captureFps)
        .put("cameraEnabled", cameraEnabled)
        .put("microphoneEnabled", microphoneEnabled)
        .put("flashAvailable", hasTorchSupport())
        .put("flashEnabled", isTorchEnabled())

    fun switchCamera(facing: String) {
        check(cameraEnabled) { "カメラがOFFの間は切り替えできません。先にカメラをONにしてください。" }
        val camera = capturer ?: return
        val wantFront = facing == "front"
        if (wantFront == frontCamera) return
        if (wantFront && torchRequested) {
            try { setTorchEnabled(false) } catch (error: Exception) {
                Log.w("RemoteCameraRTC", "Torch OFF before front-camera switch failed", error)
                torchRequested = false
            }
        }
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
        check(cameraEnabled) { "カメラがOFFの間は切り替えできません。先にカメラをONにしてください。" }
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
            // Create and initialise a candidate only once. The fallback helper owns
            // every failed capturer and disposes it before trying the next format.
            val profile = profileFor(currentQuality, currentDataMode, currentFps, cameraId)
            val started = startCaptureWithFallback(
                enumerator, cameraId, currentHelper, currentSource, profile
            )
            replacement = started.capturer
            capturer = replacement
            selectedCameraId = cameraId
            frontCamera = option.facing == "front"
            captureWidth = started.width
            captureHeight = started.height
            captureFps = started.fps
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

    @Synchronized
    fun setQuality(quality: String, dataMode: String, fps: Int = currentFps, aspectRatio: String = currentAspectRatio) {
        val previousQuality = currentQuality
        val previousDataMode = currentDataMode
        val previousFps = currentFps
        val previousRatio = currentAspectRatio
        val nextRatio = aspectRatio.takeIf {
            it in setOf("16:9", "4:3", "1:1", "9:16", "original")
        } ?: "original"
        val requestedFps = fps.coerceIn(10, 60)
        val captureChanged = quality != previousQuality || dataMode != previousDataMode ||
            requestedFps != previousFps || nextRatio != previousRatio
        currentAspectRatio = nextRatio
        val profile = profileFor(quality, dataMode, requestedFps, selectedCameraId)
        val camera = capturer
        if (camera != null && captureChanged && cameraEnabled) {
            val currentHelper = helper ?: error("カメラ初期化情報がありません。")
            val currentSource = videoSource ?: error("映像ソースがありません。")
            val oldProfile = VideoProfile(captureWidth, captureHeight, captureFps, profile.bitrate)
            try {
                // Recreate only the capturer; keep PeerConnections, audio and control channels alive.
                try { camera.stopCapture() } catch (_: Exception) {}
                try { camera.dispose() } catch (_: Exception) {}
                capturer = null
                val started = startCaptureWithFallback(
                    Camera2Enumerator(context), selectedCameraId, currentHelper, currentSource, profile
                )
                capturer = started.capturer
                captureWidth = started.width
                captureHeight = started.height
                captureFps = started.fps
            } catch (error: Exception) {
                Log.w("RemoteCameraRTC", "Requested camera format failed; restoring previous format", error)
                try {
                    val restored = startCaptureWithFallback(
                        Camera2Enumerator(context), selectedCameraId, currentHelper, currentSource, oldProfile
                    )
                    capturer = restored.capturer
                    captureWidth = restored.width
                    captureHeight = restored.height
                    captureFps = restored.fps
                } catch (restoreError: Exception) {
                    Log.e("RemoteCameraRTC", "Previous camera format could not be restored", restoreError)
                    capturer = null
                    cameraEnabled = false
                    videoTrack?.setEnabled(false)
                }
                currentQuality = previousQuality
                currentDataMode = previousDataMode
                currentFps = previousFps
                currentAspectRatio = previousRatio
                onState("画質変更に失敗しました。以前の撮影形式へ戻しました。")
                throw IllegalStateException("端末が指定した画質に対応していません。以前の画質を維持します。", error)
            }
        }
        currentQuality = quality
        currentDataMode = dataMode
        currentFps = requestedFps
        videoSenders.values.forEach { sender ->
            try {
                val params = sender.parameters
                params.encodings.forEach {
                    it.maxBitrateBps = profile.bitrate
                    it.maxFramerate = if (cameraEnabled) captureFps else requestedFps
                }
                if (!sender.setParameters(params)) {
                    Log.w("RemoteCameraRTC", "Video sender rejected quality parameters")
                    onState("画質の送信設定を反映できませんでした。")
                }
            } catch (error: Exception) {
                Log.w("RemoteCameraRTC", "Could not change video bitrate", error)
                onState("画質の送信設定を変更できませんでした。")
            }
        }
        if (captureChanged && capturer != null) {
            onState("撮影設定を適用しました：${captureWidth}×${captureHeight} @ ${captureFps}FPS")
        }
    }

    @Synchronized
    private fun stopMedia() {
        try {
            if (torchRequested) (capturer as? TorchCaptureControl)?.setTorchEnabled(false)
        } catch (error: Exception) {
            Log.w("RemoteCameraRTC", "Could not switch off in-stream torch during media cleanup", error)
        }
        torchRequested = false
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