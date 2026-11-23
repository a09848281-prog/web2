package jp.a09848281.remotecamera

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.AlarmManager
import android.app.DatePickerDialog
import android.app.PendingIntent
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.util.Log
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.NumberPicker
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.Switch
import android.widget.SeekBar
import android.widget.ArrayAdapter
import android.widget.AdapterView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var status: TextView
    private lateinit var codeView: TextView
    private lateinit var startButton: Button
    private lateinit var refreshCodeButton: Button
    private lateinit var stopButton: Button
    private lateinit var pollIntervalInput: EditText
    private lateinit var qualitySpinner: Spinner
    private lateinit var fpsSpinner: Spinner
    private lateinit var pairingDurationSpinner: Spinner
    private lateinit var batteryAutoDisconnectSwitch: Switch
    private lateinit var batteryWaitSwitch: Switch
    private lateinit var batteryThresholdLabel: TextView
    private lateinit var scheduleStartButton: Button
    private lateinit var scheduleEndButton: Button
    private lateinit var scheduleStatus: TextView
    private var scheduleStartAt = 0L
    private var scheduleEndAt = 0L
    private var pendingExactAlarmPermission = false
    private var uiInitialized = false
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
            setPadding(0, 12, 0, 12)
        }
        root.addView(status)
        root.addView(codeView)
        root.addView(TextView(this).apply {
            text = "ペアリングコードの有効時間"
            textSize = 14f
            setTextColor(0xFF586980.toInt())
            setPadding(0, 4, 0, 4)
        })
        pairingDurationSpinner = Spinner(this)
        val pairingDurations = listOf(10, 20, 30, 60, 120)
        pairingDurationSpinner.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            listOf("10分", "20分", "30分", "1時間", "2時間")
        )
        pairingDurationSpinner.setSelection(
            pairingDurations.indexOf(prefs.getInt("pairingDurationMinutes", 10)).coerceAtLeast(0)
        )
        pairingDurationSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) {}
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                prefs.edit().putInt("pairingDurationMinutes", pairingDurations.getOrElse(position) { 10 }).apply()
            }
        }
        root.addView(pairingDurationSpinner, LinearLayout.LayoutParams(-1, -2))

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
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                val seconds = s?.toString()?.toIntOrNull()
                if (seconds != null && seconds in AppConfig.MIN_POLL_SECONDS..AppConfig.MAX_POLL_SECONDS) {
                    prefs.edit().putInt("pollIntervalSeconds", seconds).apply()
                }
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        root.addView(TextView(this).apply {
            text = "Web接続時の撮影設定"
            textSize = 14f
            setTextColor(0xFF586980.toInt())
            setPadding(0, 18, 0, 4)
        })
        qualitySpinner = Spinner(this)
        val qualityLabels = listOf("360p", "480p", "720p", "1080p")
        qualitySpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, qualityLabels)
        val savedQuality = prefs.getString("requestedQuality", "720") ?: "720"
        qualitySpinner.setSelection(listOf("360", "480", "720", "1080").indexOf(savedQuality).coerceAtLeast(0))
        root.addView(qualitySpinner, LinearLayout.LayoutParams(-1, -2))
        fpsSpinner = Spinner(this)
        val fpsOptions = listOf("10 FPS", "15 FPS", "20 FPS", "24 FPS", "30 FPS", "40 FPS", "45 FPS", "50 FPS", "55 FPS", "60 FPS")
        fpsSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, fpsOptions)
        val savedFps = prefs.getInt("fps", 24)
        fpsSpinner.setSelection(listOf(10, 15, 20, 24, 30, 40, 45, 50, 55, 60).indexOf(savedFps).coerceAtLeast(0))
        root.addView(fpsSpinner, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "これは待機中に撮影する設定ではありません。Webから接続され、Androidカメラが起動したときに使う画質とFPSです。待機中は撮影・録画しません。1080p・60FPSは端末対応時のみ反映されます。"
            textSize = 12f
            setTextColor(0xFF66758B.toInt())
            setPadding(0, 4, 0, 10)
        })
        root.addView(Button(this).apply {
            text = "接続時の画質・FPSを保存"
            setOnClickListener { saveNativeVideoSettings() }
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "待機開始・終了の予約"
            textSize = 14f
            setTextColor(0xFF586980.toInt())
            setPadding(0, 18, 0, 4)
        })
        scheduleStartAt = prefs.getLong("scheduleStartAt", 0L)
        scheduleEndAt = prefs.getLong("scheduleEndAt", 0L)
        scheduleStartButton = Button(this).apply { setOnClickListener { pickScheduleTime(true) } }
        scheduleEndButton = Button(this).apply { setOnClickListener { pickScheduleTime(false) } }
        root.addView(scheduleStartButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(scheduleEndButton, LinearLayout.LayoutParams(-1, -2))
        val scheduleSaveButton = Button(this).apply {
            text = "開始・終了を予約"
            setOnClickListener { saveMonitoringSchedule() }
        }
        val scheduleClearButton = Button(this).apply {
            text = "予約を解除"
            setOnClickListener { clearMonitoringSchedule() }
        }
        root.addView(scheduleSaveButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(scheduleClearButton, LinearLayout.LayoutParams(-1, -2))
        scheduleStatus = TextView(this).apply {
            textSize = 12f
            setTextColor(0xFF66758B.toInt())
            setPadding(0, 4, 0, 8)
        }
        root.addView(scheduleStatus, LinearLayout.LayoutParams(-1, -2))
        updateScheduleLabels()
        root.addView(refreshCodeButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(startButton, LinearLayout.LayoutParams(-1, -2))
        root.addView(stopButton, LinearLayout.LayoutParams(-1, -2))

        root.addView(TextView(this).apply {
            text = "バッテリー保護"
            textSize = 16f
            setTextColor(0xFF17243A.toInt())
            setPadding(0, 22, 0, 6)
        })
        batteryAutoDisconnectSwitch = Switch(this).apply {
            text = "指定残量でカメラ接続を自動切断"
            isChecked = prefs.getBoolean("batteryAutoDisconnectEnabled", false)
        }
        root.addView(batteryAutoDisconnectSwitch, LinearLayout.LayoutParams(-1, -2))
        batteryThresholdLabel = TextView(this).apply {
            textSize = 13f
            setTextColor(0xFF586980.toInt())
            setPadding(0, 5, 0, 2)
        }
        root.addView(batteryThresholdLabel, LinearLayout.LayoutParams(-1, -2))
        val batteryThreshold = SeekBar(this).apply {
            max = 45
            progress = (prefs.getInt("batteryCutoffPercent", 20).coerceIn(5, 50) - 5)
            isEnabled = batteryAutoDisconnectSwitch.isChecked
        }
        root.addView(batteryThreshold, LinearLayout.LayoutParams(-1, -2))
        batteryThresholdLabel.text = "切断する電池残量：${batteryThreshold.progress + 5}%"
        batteryThreshold.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                val value = progress + 5
                batteryThresholdLabel.text = "切断する電池残量：${value}%"
                if (fromUser) prefs.edit().putInt("batteryCutoffPercent", value).apply()
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) { applyBatteryOptionsToService() }
        })
        batteryAutoDisconnectSwitch.setOnCheckedChangeListener { _, checked ->
            batteryThreshold.isEnabled = checked
            prefs.edit().putBoolean("batteryAutoDisconnectEnabled", checked).apply()
            applyBatteryOptionsToService()
        }
        batteryWaitSwitch = Switch(this).apply {
            text = "切断後も待機を続ける（充電・残量回復を監視）"
            isChecked = prefs.getBoolean("batteryWaitEnabled", true)
            setOnCheckedChangeListener { _, checked ->
                prefs.edit().putBoolean("batteryWaitEnabled", checked).apply()
                applyBatteryOptionsToService()
            }
        }
        root.addView(batteryWaitSwitch, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "自動切断は充電中には動作しません。待機ONではカメラ・マイク・WebRTCを停止し、軽い監視待機だけを続けます。待機OFFではサービス自体を停止します。"
            textSize = 12f
            setTextColor(0xFF66758B.toInt())
            setPadding(0, 2, 0, 8)
        })

        root.addView(TextView(this).apply {
            text = "開始ボタンを押すと通知欄に待機状態が表示されます。アプリを表示した状態でカメラ・マイクなどの権限を許可してから待機を開始してください。強制停止・再起動・権限取消後の自動復帰は保証されません。"
            textSize = 13f
            setTextColor(0xFF66758B.toInt())
            setPadding(0, 22, 0, 0)
        })
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
        uiInitialized = true
        scheduleStartAt = prefs.getLong("scheduleStartAt", 0L)
        scheduleEndAt = prefs.getLong("scheduleEndAt", 0L)
        updateScheduleLabels()
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
                if (!gasUrl.startsWith("https://script.google.com/macros/s/") ||
                    !gasUrl.endsWith("/exec") || gasUrl.contains("GAS_EXEC_URL_HERE") ||
                    gasUrl.contains("PASTE_YOUR_DEPLOYMENT_ID")) {
                    status.text = "GitHubの config.json にGAS URLを設定してください。"
                } else {
                    prefs.edit().putString("gasUrl", gasUrl).apply()
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

    private fun saveNativeVideoSettings() {
        val quality = listOf("360", "480", "720", "1080").getOrElse(qualitySpinner.selectedItemPosition) { "720" }
        val fps = listOf(10, 15, 20, 24, 30, 40, 45, 50, 55, 60).getOrElse(fpsSpinner.selectedItemPosition) { 24 }
        prefs.edit()
            .putString("requestedQuality", quality)
            .putInt("fps", fps)
            .putString("aspectRatio", "original")
            .putString("requestedDataMode", "standard")
            .putBoolean("nativeVideoOverride", true)
            .apply()
        if (prefs.getBoolean("monitoringEnabled", false)) {
            try {
                val update = Intent(this, MonitorService::class.java).apply {
                    action = MonitorService.ACTION_VIDEO_SETTINGS
                    putExtra("quality", quality)
                    putExtra("fps", fps)
                    putExtra("aspectRatio", "original")
                }
                ContextCompat.startForegroundService(this, update)
                status.text = "撮影設定を保存し、待機サービスへ送信しました。"
            } catch (error: Exception) {
                status.text = "設定は保存しました。サービス反映は次回接続時に行います。"
            }
        }
    }

    private fun pickScheduleTime(isStart: Boolean) {
        val initial = Calendar.getInstance().apply {
            val stored = if (isStart) scheduleStartAt else scheduleEndAt
            if (stored > 0L) timeInMillis = stored else add(Calendar.MINUTE, 10)
        }
        DatePickerDialog(this, { _, year, month, day ->
            val selected = Calendar.getInstance().apply {
                set(Calendar.YEAR, year)
                set(Calendar.MONTH, month)
                set(Calendar.DAY_OF_MONTH, day)
                set(Calendar.MILLISECOND, 0)
            }
            TimePickerDialog(this, { _, hour, minute ->
                selected.set(Calendar.HOUR_OF_DAY, hour)
                selected.set(Calendar.MINUTE, minute)
                val secondsLabel = TextView(this).apply {
                    text = "秒（0～59）"
                    textSize = 16f
                    setPadding(24, 18, 24, 4)
                }
                val secondsPicker = NumberPicker(this).apply {
                    minValue = 0
                    maxValue = 59
                    value = if ((if (isStart) scheduleStartAt else scheduleEndAt) > 0L) {
                        Calendar.getInstance().apply {
                            timeInMillis = if (isStart) scheduleStartAt else scheduleEndAt
                        }.get(Calendar.SECOND)
                    } else initial.get(Calendar.SECOND)
                    setFormatter { value -> String.format(Locale.JAPAN, "%02d", value) }
                }
                val content = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(secondsLabel)
                    addView(secondsPicker)
                    setPadding(12, 4, 12, 12)
                }
                AlertDialog.Builder(this)
                    .setTitle("秒を指定")
                    .setView(content)
                    .setNegativeButton("キャンセル", null)
                    .setPositiveButton("設定") { _, _ ->
                        selected.set(Calendar.SECOND, secondsPicker.value)
                        val stamp = selected.timeInMillis
                        if (isStart) scheduleStartAt = stamp else scheduleEndAt = stamp
                        updateScheduleLabels()
                    }
                    .show()
            }, initial.get(Calendar.HOUR_OF_DAY), initial.get(Calendar.MINUTE), true).show()
        }, initial.get(Calendar.YEAR), initial.get(Calendar.MONTH), initial.get(Calendar.DAY_OF_MONTH)).show()
    }

    private fun formatScheduleTime(value: Long): String {
        if (value <= 0L) return "未設定"
        return SimpleDateFormat("yyyy/MM/dd HH:mm:ss", Locale.JAPAN).format(Date(value))
    }

    private fun updateScheduleLabels() {
        if (!::scheduleStartButton.isInitialized) return
        scheduleStartButton.text = "開始：${formatScheduleTime(scheduleStartAt)} を選択"
        scheduleEndButton.text = "終了：${formatScheduleTime(scheduleEndAt)} を選択"
        if (::scheduleStatus.isInitialized) {
            scheduleStatus.text = if (scheduleStartAt > 0L && scheduleEndAt > scheduleStartAt) {
                "予約設定あり（Androidの省電力・起動制限により時刻が遅れる場合があります）"
            } else "開始・終了の両方を選択してください。"
        }
    }

    private fun createSchedulePendingIntent(action: String): PendingIntent {
        val requestCode = if (action == ScheduleReceiver.ACTION_START) 8101 else 8102
        val intent = Intent(this, ScheduleReceiver::class.java).setAction(action)
        return PendingIntent.getBroadcast(
            this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun saveMonitoringSchedule() {
        if (!gasUrl.startsWith("https://script.google.com/macros/s/") || !gasUrl.endsWith("/exec")) {
            Toast.makeText(this, "GAS URLの読み込みが完了してから予約してください。", Toast.LENGTH_LONG).show()
            return
        }
        if (scheduleStartAt <= System.currentTimeMillis() || scheduleEndAt <= scheduleStartAt) {
            Toast.makeText(this, "未来の開始時刻と、その後の終了時刻を選択してください。", Toast.LENGTH_LONG).show()
            return
        }
        val alarm = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarm.canScheduleExactAlarms()) {
            try {
                pendingExactAlarmPermission = true
                startActivity(
                    Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                        .setData(Uri.parse("package:$packageName"))
                )
                Toast.makeText(this, "正確な時刻で予約するため、アラームとリマインダーの許可をONにして、戻ってからもう一度予約してください。", Toast.LENGTH_LONG).show()
            } catch (error: Exception) {
                Toast.makeText(this, "正確なアラームの許可画面を開けませんでした：" + (error.message ?: "不明"), Toast.LENGTH_LONG).show()
            }
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduleStartAt, createSchedulePendingIntent(ScheduleReceiver.ACTION_START))
                alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduleEndAt, createSchedulePendingIntent(ScheduleReceiver.ACTION_STOP))
            } else {
                alarm.setExact(AlarmManager.RTC_WAKEUP, scheduleStartAt, createSchedulePendingIntent(ScheduleReceiver.ACTION_START))
                alarm.setExact(AlarmManager.RTC_WAKEUP, scheduleEndAt, createSchedulePendingIntent(ScheduleReceiver.ACTION_STOP))
            }
            prefs.edit().putLong("scheduleStartAt", scheduleStartAt).putLong("scheduleEndAt", scheduleEndAt).apply()
            updateScheduleLabels()
            syncScheduleToGas(scheduleStartAt, scheduleEndAt)
            Toast.makeText(this, "開始・終了を秒単位で予約しました。", Toast.LENGTH_LONG).show()
        } catch (error: SecurityException) {
            Toast.makeText(this, "正確なアラームの権限がありません。設定から許可してください。", Toast.LENGTH_LONG).show()
        }
    }

    private fun syncScheduleToGas(startAt: Long, endAt: Long) {
        // Keep a durable pending flag so the service can retry a transient network failure.
        prefs.edit().putBoolean("scheduleSyncPending", true).apply()
        val id = prefs.getString("deviceId", "") ?: ""
        val secret = prefs.getString("deviceSecret", "") ?: ""
        if (id.isBlank() || secret.isBlank() || gasUrl.isBlank()) {
            if (::scheduleStatus.isInitialized) scheduleStatus.text = scheduleStatus.text.toString() + "\nWeb同期：Android端末の登録後に同期します。"
            return
        }
        val url = gasUrl
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    ApiClient(url).call("save_device_schedule", JSONObject()
                        .put("deviceId", id).put("deviceSecret", secret)
                        .put("startAt", startAt).put("endAt", endAt))
                }
                val stillCurrent = prefs.getLong("scheduleStartAt", 0L) == startAt &&
                    prefs.getLong("scheduleEndAt", 0L) == endAt
                if (stillCurrent) prefs.edit().putBoolean("scheduleSyncPending", false).apply()
                if (::scheduleStatus.isInitialized && scheduleStartAt == startAt && scheduleEndAt == endAt) {
                    scheduleStatus.text = scheduleStatus.text.toString() + "\nWeb同期：完了"
                }
            } catch (error: Exception) {
                Log.w("RemoteCameraSchedule", "Could not sync Android schedule to Web; retry is pending", error)
                if (::scheduleStatus.isInitialized && scheduleStartAt == startAt && scheduleEndAt == endAt) {
                    scheduleStatus.text = scheduleStatus.text.toString() + "\nWeb同期：失敗（再試行待ち・予約はAndroid内に保存済み）"
                }
            }
        }
    }

    private fun clearMonitoringSchedule() {
        val alarm = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarm.cancel(createSchedulePendingIntent(ScheduleReceiver.ACTION_START))
        alarm.cancel(createSchedulePendingIntent(ScheduleReceiver.ACTION_STOP))
        scheduleStartAt = 0L
        scheduleEndAt = 0L
        prefs.edit().remove("scheduleStartAt").remove("scheduleEndAt").apply()
        updateScheduleLabels()
        syncScheduleToGas(0L, 0L)
        Toast.makeText(this, "予約を解除しました。", Toast.LENGTH_SHORT).show()
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
        val requestedSeconds = pollIntervalInput.text?.toString()?.toIntOrNull() ?: AppConfig.POLL_SECONDS.toInt()
        if (requestedSeconds !in AppConfig.MIN_POLL_SECONDS..AppConfig.MAX_POLL_SECONDS) {
            Toast.makeText(this, "確認間隔は1～50秒で入力してください。", Toast.LENGTH_LONG).show()
            return
        }
        prefs.edit()
            .putInt("pollIntervalSeconds", requestedSeconds)
            .putBoolean("monitoringEnabled", true)
            .apply()
        val selectedPairingMinutes = listOf(10, 20, 30, 60, 120)
            .getOrElse(pairingDurationSpinner.selectedItemPosition) { 10 }
        prefs.edit().putInt("pairingDurationMinutes", selectedPairingMinutes).apply()
        val intent = Intent(this, MonitorService::class.java).apply {
            action = MonitorService.ACTION_START
            putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
            putExtra(MonitorService.EXTRA_POLL_INTERVAL_SECONDS, requestedSeconds)
            putExtra(MonitorService.EXTRA_PAIRING_DURATION_MINUTES, selectedPairingMinutes)
        }
        try {
            ContextCompat.startForegroundService(this, intent)
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
        val selectedPairingMinutes = listOf(10, 20, 30, 60, 120)
            .getOrElse(pairingDurationSpinner.selectedItemPosition) { 10 }
        prefs.edit().putInt("pairingDurationMinutes", selectedPairingMinutes).apply()
        val intent = Intent(this, MonitorService::class.java).apply {
            action = MonitorService.ACTION_REFRESH_CODE
            putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
            putExtra(MonitorService.EXTRA_PAIRING_DURATION_MINUTES, selectedPairingMinutes)
        }
        try {
            ContextCompat.startForegroundService(this, intent)
            Toast.makeText(this, "ペアリングコードを発行・再発行しています。", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "再発行できません：" + (e.message ?: "エラー"), Toast.LENGTH_LONG).show()
        }
    }

    private fun applyBatteryOptionsToService() {
        if (!prefs.getBoolean("monitoringEnabled", false) || gasUrl.isBlank()) return
        try {
            val update = Intent(this, MonitorService::class.java).apply {
                action = MonitorService.ACTION_BATTERY_SETTINGS
                putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
            }
            ContextCompat.startForegroundService(this, update)
        } catch (error: Exception) {
            Log.w("RemoteCameraBattery", "Could not update battery guard immediately; saved preferences will apply on next start", error)
        }
    }

    private fun stopMonitoring() {
        StopMonitoringReceiver.stop(this)
        status.text = "監視待機を停止しました。カメラ・マイク・通信を終了しました。"
        refreshMonitoringButtons()
    }

    private fun showSavedCode() {
        val code = prefs.getString("registrationCode", "") ?: ""
        val id = prefs.getString("deviceId", "") ?: ""
        codeView.text = when {
            id.isBlank() -> "ペアリングコード：--"
            code.isNotBlank() -> {
                val expiry = prefs.getLong("codeExpiresAt", 0L)
                val expiryLabel = if (expiry > System.currentTimeMillis()) {
                    "\n有効期限：" + SimpleDateFormat("HH:mm", Locale.JAPAN).format(Date(expiry))
                } else "\n有効期限切れ・再発行してください"
                "ペアリングコード：$code\n端末ID：$id$expiryLabel"
            }
            prefs.getBoolean("serverPaired", false) ->
                "GASでペアリング確認済み\n端末ID：$id"
            else -> "端末情報あり・GAS確認待ち\n端末ID：$id"
        }
    }

    override fun onResume() {
        super.onResume()
        prefs.edit().putBoolean("mainActivityVisible", true).apply()
        val filter = android.content.IntentFilter(MonitorService.ACTION_CODE).apply {
            addAction(ACTION_MONITOR_STOPPED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(codeReceiver, filter, RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(codeReceiver, filter)
        showSavedCode()
        refreshMonitoringButtons()
        if (pendingExactAlarmPermission) {
            pendingExactAlarmPermission = false
            val alarm = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms()) {
                saveMonitoringSchedule()
            } else {
                Toast.makeText(this, "正確なアラームが許可されていないため、予約は保存されていません。", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onPause() {
        prefs.edit().putBoolean("mainActivityVisible", false).apply()
        try { unregisterReceiver(codeReceiver) } catch (_: Exception) {}
        super.onPause()
    }

    private val codeReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context?, intent: Intent?) {
            if (intent?.action == ACTION_MONITOR_STOPPED) {
                prefs.edit().putBoolean("androidKeepScreenAwake", false).apply()
                status.text = "監視待機を停止しました。カメラ・マイク・通信は終了しています。"
                refreshMonitoringButtons()
                return
            }
            val code = intent?.getStringExtra(MonitorService.EXTRA_CODE) ?: return
            val id = intent.getStringExtra(MonitorService.EXTRA_DEVICE_ID) ?: ""
            val expiresAt = intent.getLongExtra(MonitorService.EXTRA_CODE_EXPIRES_AT, 0L)
            prefs.edit().putLong("codeExpiresAt", expiresAt).apply()
            if (code.isNotBlank()) {
                codeView.text = "ペアリングコード：$code\n端末ID：$id\n有効期限：" +
                    if (expiresAt > 0L) SimpleDateFormat("HH:mm", Locale.JAPAN).format(Date(expiresAt)) else "不明"
            } else {
                showSavedCode()
            }
        }
    }

    override fun onStop() {
        val seconds = pollIntervalInput.text?.toString()?.toIntOrNull()
        if (seconds != null && seconds in AppConfig.MIN_POLL_SECONDS..AppConfig.MAX_POLL_SECONDS) {
            prefs.edit().putInt("pollIntervalSeconds", seconds).commit()
        }
        super.onStop()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_MONITOR_STOPPED = "jp.a09848281.remotecamera.MONITOR_STOPPED"
    }
}
