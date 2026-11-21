package jp.a09848281.remotecamera

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var status: TextView
    private lateinit var codeView: TextView
    private lateinit var startButton: Button
    private lateinit var refreshCodeButton: Button
    private lateinit var stopButton: Button
    private lateinit var pollIntervalInput: EditText
    private lateinit var maxBitrateInput: EditText
    private lateinit var dailyStartInput: EditText
    private lateinit var dailyEndInput: EditText
    private var gasUrl = ""
    private val prefs by lazy { getSharedPreferences(AppConfig.PREFS, MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(28, 40, 28, 28)
            setBackgroundColor(0xFFF2F5FA.toInt())
        }
        root.addView(TextView(this).apply {
            text = "Remote Camera"
            textSize = 28f
            setTextColor(0xFF17243A.toInt())
        })
        status = TextView(this).apply {
            text = "設定を読み込んでいます…"
            textSize = 15f
            setTextColor(0xFF586980.toInt())
            setPadding(0, 26, 0, 16)
        }
        codeView = TextView(this).apply {
            text = "ペアリングコード：--"
            textSize = 22f
            setTextColor(0xFF2862C8.toInt())
            setPadding(0, 12, 0, 24)
        }

        refreshCodeButton = Button(this).apply {
            text = "ペアリングコードを発行・再発行"
            isEnabled = false
            setOnClickListener { requestRefreshCode() }
        }
        startButton = Button(this).apply {
            text = "監視待機を開始"
            isEnabled = false
            setOnClickListener { requestStart() }
        }
        stopButton = Button(this).apply {
            text = "監視待機を停止"
            isEnabled = false
            setOnClickListener { stopMonitoring() }
        }
        root.addView(status)
        root.addView(codeView)
        root.addView(TextView(this).apply {
            text = "GASへの問い合わせ間隔（1～50秒）"
            textSize = 14f
            setTextColor(0xFF586980.toInt())
            setPadding(0, 8, 0, 4)
        })
        pollIntervalInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setSingleLine(true)
            setText(prefs.getInt("pollIntervalSeconds", AppConfig.POLL_SECONDS.toInt()).toString())
            hint = "例：10"
        }
        root.addView(pollIntervalInput, LinearLayout.LayoutParams(-1, -2))
        pollIntervalInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                s?.toString()?.toIntOrNull()?.takeIf { it in AppConfig.MIN_POLL_SECONDS..AppConfig.MAX_POLL_SECONDS }?.let {
                    prefs.edit().putInt("pollIntervalSeconds", it).apply()
                    pushSettingsToService()
                }
            }
        })
        root.addView(TextView(this).apply { text = "映像ビットレート上限（150～8000 kbps）"; textSize = 14f; setTextColor(0xFF586980.toInt()); setPadding(0,12,0,4) })
        maxBitrateInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setSingleLine(true)
            setText(prefs.getInt("maxBitrateKbps",2500).toString())
            hint = "例：2500"
        }
        root.addView(maxBitrateInput, LinearLayout.LayoutParams(-1,-2))
        maxBitrateInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                s?.toString()?.toIntOrNull()?.takeIf { it in 150..8000 }?.let { prefs.edit().putInt("maxBitrateKbps",it).apply(); pushSettingsToService() }
            }
        })
        root.addView(TextView(this).apply { text = "毎日の監視待機予約（24時間制）"; textSize = 15f; setTextColor(0xFF17243A.toInt()); setPadding(0,20,0,4) })
        dailyStartInput = EditText(this).apply { setSingleLine(true); setText(prefs.getString("dailyStartTime","08:00")); hint = "開始 HH:mm" }
        dailyEndInput = EditText(this).apply { setSingleLine(true); setText(prefs.getString("dailyEndTime","23:00")); hint = "終了 HH:mm" }
        root.addView(TextView(this).apply { text = "開始時刻"; textSize = 13f; setTextColor(0xFF586980.toInt()) })
        root.addView(dailyStartInput,LinearLayout.LayoutParams(-1,-2))
        root.addView(TextView(this).apply { text = "終了時刻"; textSize = 13f; setTextColor(0xFF586980.toInt()) })
        root.addView(dailyEndInput,LinearLayout.LayoutParams(-1,-2))
        root.addView(Button(this).apply { text = "毎日の予約を有効にする"; setOnClickListener { saveDailySchedule() } },LinearLayout.LayoutParams(-1,-2))
        root.addView(Button(this).apply { text = "毎日の予約を解除"; setOnClickListener { MonitorSchedule.cancel(this@MainActivity); Toast.makeText(this@MainActivity,"毎日の予約を解除しました。",Toast.LENGTH_SHORT).show() } },LinearLayout.LayoutParams(-1,-2))
        root.addView(TextView(this).apply { text = "予約は省電力・Androidの制御により遅れる場合があります。待機中はカメラ・マイクを起動しません。"; textSize = 12f; setTextColor(0xFF66758B.toInt()); setPadding(0,6,0,10) })
        root.addView(refreshCodeButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(startButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(stopButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "開始ボタンを押すと通知欄に待機状態が表示されます。アプリを表示した状態でカメラ・マイクなどの権限を許可してから待機を開始してください。強制停止・再起動・権限取消後の自動復帰は保証されません。"
            textSize = 13f
            setTextColor(0xFF66758B.toInt())
            setPadding(0, 22, 0, 0)
        })
        setContentView(root)
        loadRemoteConfig()
    }

    private fun loadRemoteConfig() {
        scope.launch {
            try {
                gasUrl = withContext(Dispatchers.IO) {
                    val c = URL(AppConfig.REMOTE_CONFIG_URL).openConnection() as HttpURLConnection
                    c.connectTimeout = 12000
                    c.readTimeout = 12000
                    try {
                        JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optString("gasUrl", "")
                    } finally { c.disconnect() }
                }
                prefs.edit().putString("gasUrl",gasUrl).apply()
                if (!gasUrl.startsWith("https://script.google.com/macros/s/") ||
                    !gasUrl.endsWith("/exec") || gasUrl.contains("GAS_EXEC_URL_HERE") ||
                    gasUrl.contains("PASTE_YOUR_DEPLOYMENT_ID")) {
                    status.text = "GitHubの config.json にGAS URLを設定してください。"
                } else {
                    status.text = "設定を取得しました。必要な権限を許可して待機を開始できます。"
                    refreshMonitoringButtons()
                    refreshCodeButton.isEnabled = true
                    showSavedCode()
                }
            } catch (e: Exception) {
                status.text = "設定取得エラー：" + (e.message ?: "通信エラー")
            }
        }
    }

    private fun pushSettingsToService() {
        if(!prefs.getBoolean("monitoringEnabled",false))return
        val update=Intent(this,MonitorService::class.java).apply {
            action=MonitorService.ACTION_UPDATE_SETTINGS
            putExtra(MonitorService.EXTRA_MAX_BITRATE_KBPS,prefs.getInt("maxBitrateKbps",2500))
        }
        try { ContextCompat.startForegroundService(this,update) }
        catch(error:Exception){Log.w("RemoteCameraMain","Could not send live settings update",error)}
    }

    private fun saveDailySchedule() {
        val start=dailyStartInput.text?.toString()?.trim().orEmpty()
        val end=dailyEndInput.text?.toString()?.trim().orEmpty()
        try {
            MonitorSchedule.scheduleDaily(this,start,end)
            Toast.makeText(this,"毎日の待機予約を設定しました。開始 $start / 終了 $end",Toast.LENGTH_LONG).show()
        } catch(error:Exception) {
            Toast.makeText(this,error.message ?: "予約を設定できませんでした。",Toast.LENGTH_LONG).show()
        }
    }

    private fun requestStart() {
        val requested = mutableListOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) requested.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = requested.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 310)
        else startMonitoring()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 310) {
            val cameraOk = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            val micOk = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            val locationOk = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (cameraOk && micOk) startMonitoring()
            else Toast.makeText(this, "カメラとマイクの権限が必要です。位置情報は任意です。", Toast.LENGTH_LONG).show()
        }
    }

    private fun refreshMonitoringButtons() {
        val running = prefs.getBoolean("monitoringEnabled", false)
        startButton.isEnabled = gasUrl.isNotBlank() && !running
        stopButton.isEnabled = running
    }

    private fun startMonitoring() {
        val requestedSeconds = pollIntervalInput.text?.toString()?.toIntOrNull() ?: prefs.getInt("pollIntervalSeconds",AppConfig.POLL_SECONDS.toInt())
        val requestedBitrate = maxBitrateInput.text?.toString()?.toIntOrNull() ?: prefs.getInt("maxBitrateKbps",2500)
        if(requestedBitrate !in 150..8000){Toast.makeText(this,"ビットレート上限は150～8000 kbpsで入力してください。",Toast.LENGTH_LONG).show();return}
        prefs.edit().putInt("maxBitrateKbps",requestedBitrate).apply()
        if (requestedSeconds !in AppConfig.MIN_POLL_SECONDS..AppConfig.MAX_POLL_SECONDS) {
            Toast.makeText(this, "確認間隔は1～50秒で入力してください。", Toast.LENGTH_LONG).show()
            return
        }
        prefs.edit().putInt("pollIntervalSeconds", requestedSeconds).apply()
        val intent = Intent(this, MonitorService::class.java).apply {
            action = MonitorService.ACTION_START
            putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
            putExtra(MonitorService.EXTRA_POLL_INTERVAL_SECONDS, requestedSeconds)
        }
        try {
            ContextCompat.startForegroundService(this, intent)
            prefs.edit().putBoolean("monitoringEnabled", true).apply()
            status.text = "監視待機を開始しました。通知欄からも停止できます。"
            refreshMonitoringButtons()
        } catch (e: Exception) {
            prefs.edit().putBoolean("monitoringEnabled", false).apply()
            status.text = "待機開始エラー：" + (e.message ?: "開始できませんでした")
            refreshMonitoringButtons()
        }
    }

    private fun requestRefreshCode() {
        if (gasUrl.isBlank()) {
            Toast.makeText(this, "GAS設定を読み込めていません。", Toast.LENGTH_LONG).show()
            return
        }
        val savedDeviceId = prefs.getString("deviceId", "") ?: ""
        val savedDeviceSecret = prefs.getString("deviceSecret", "") ?: ""
        if (savedDeviceId.isBlank() || savedDeviceSecret.isBlank()) {
            Toast.makeText(this, "先に「監視待機を開始」を押して端末を初期登録してください。", Toast.LENGTH_LONG).show()
            return
        }
        val cameraOk = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        val micOk = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!cameraOk || !micOk) {
            Toast.makeText(this, "カメラとマイクの権限を許可してから操作してください。位置情報は任意です。", Toast.LENGTH_LONG).show()
            requestStart()
            return
        }
        val intent = Intent(this, MonitorService::class.java).apply {
            action = MonitorService.ACTION_REFRESH_CODE
            putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
        }
        try {
            ContextCompat.startForegroundService(this, intent)
            Toast.makeText(this, "ペアリングコードを発行・再発行しています。", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "再発行できません：" + (e.message ?: "エラー"), Toast.LENGTH_LONG).show()
        }
    }

    private fun stopMonitoring() {
        val stopIntent = Intent(this, MonitorService::class.java).setAction(MonitorService.ACTION_STOP)
        try {
            // Ask the running foreground service to execute its full shutdown path.
            startService(stopIntent)
            prefs.edit().putBoolean("monitoringEnabled", false).apply()
            status.text = "監視待機の停止を要求しました。カメラ・マイク・通信を終了しています。"
        } catch (error: Exception) {
            // A direct stop is a last-resort fallback if Android rejects the explicit action.
            stopService(Intent(this, MonitorService::class.java))
            prefs.edit().putBoolean("monitoringEnabled", false).apply()
            status.text = "監視サービスを停止しました。"
            Toast.makeText(this, "停止処理: " + (error.message ?: "サービス終了"), Toast.LENGTH_LONG).show()
        }
        refreshMonitoringButtons()
    }

    private fun showSavedCode() {
        val code = prefs.getString("registrationCode", "") ?: ""
        val id = prefs.getString("deviceId", "") ?: ""
        codeView.text = when {
            id.isBlank() -> "ペアリングコード：--"
            code.isNotBlank() -> "ペアリングコード：$code\n端末ID：$id"
            prefs.getBoolean("serverPaired", false) ->
                "GASでペアリング確認済み\n端末ID：$id"
            else -> "端末情報あり・GAS確認待ち\n端末ID：$id"
        }
    }

    override fun onResume() {
        super.onResume()
        val filter = android.content.IntentFilter(MonitorService.ACTION_CODE)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(codeReceiver, filter, RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(codeReceiver, filter)
        showSavedCode()
        refreshMonitoringButtons()
    }

    override fun onPause() {
        try { unregisterReceiver(codeReceiver) } catch (_: Exception) {}
        super.onPause()
    }

    private val codeReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context?, intent: Intent?) {
            val code = intent?.getStringExtra(MonitorService.EXTRA_CODE) ?: return
            val id = intent.getStringExtra(MonitorService.EXTRA_DEVICE_ID) ?: ""
            if (code.isNotBlank()) {
                codeView.text = "ペアリングコード：$code\n端末ID：$id"
            } else {
                showSavedCode()
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}