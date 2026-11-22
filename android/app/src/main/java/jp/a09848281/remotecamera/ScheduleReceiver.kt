package jp.a09848281.remotecamera

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

class ScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> restoreScheduleAfterBoot(context)
            ACTION_START -> {
                val prefs = context.getSharedPreferences(AppConfig.PREFS, Context.MODE_PRIVATE)
                val gasUrl = prefs.getString("gasUrl", "") ?: ""
                if (!gasUrl.startsWith("https://script.google.com/macros/s/") || !gasUrl.endsWith("/exec")) {
                    Log.e("RemoteCameraSchedule", "Scheduled start skipped: GAS URL is unavailable.")
                    return
                }
                val cameraGranted = androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED
                val microphoneGranted = androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
                if (!cameraGranted || !microphoneGranted) {
                    Log.e("RemoteCameraSchedule", "Scheduled start blocked: camera and microphone permissions must be granted in the app first.")
                    return
                }
                prefs.edit().putBoolean("monitoringEnabled", true).apply()
                val start = Intent(context, MonitorService::class.java).apply {
                    action = MonitorService.ACTION_START
                    putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
                    putExtra(
                        MonitorService.EXTRA_POLL_INTERVAL_SECONDS,
                        prefs.getInt("pollIntervalSeconds", AppConfig.POLL_SECONDS.toInt())
                    )
                }
                try {
                    if (Build.VERSION.SDK_INT >= 26) ContextCompat.startForegroundService(context, start)
                    else context.startService(start)
                    Log.i("RemoteCameraSchedule", "Scheduled monitoring start requested.")
                } catch (error: Exception) {
                    prefs.edit().putBoolean("monitoringEnabled", false).apply()
                    Log.e("RemoteCameraSchedule", "Android rejected scheduled foreground-service start.", error)
                }
            }
            ACTION_STOP -> {
                try {
                    StopMonitoringReceiver.stop(context)
                    Log.i("RemoteCameraSchedule", "Scheduled monitoring stop requested.")
                } catch (error: Exception) {
                    Log.e("RemoteCameraSchedule", "Scheduled monitoring stop failed.", error)
                }
            }
        }
    }

    private fun restoreScheduleAfterBoot(context: Context) {
        val prefs = context.getSharedPreferences(AppConfig.PREFS, Context.MODE_PRIVATE)
        val startAt = prefs.getLong("scheduleStartAt", 0L)
        val endAt = prefs.getLong("scheduleEndAt", 0L)
        val now = System.currentTimeMillis()
        if (endAt <= now || startAt <= 0L || endAt <= startAt) {
            if (endAt > 0L && endAt <= now) {
                prefs.edit().remove("scheduleStartAt").remove("scheduleEndAt")
                    .putBoolean("monitoringEnabled", false).apply()
            }
            return
        }
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarm.canScheduleExactAlarms()) {
            Log.w("RemoteCameraSchedule", "Exact-alarm access is not granted; saved schedule was not restored.")
            return
        }
        fun pending(action: String, requestCode: Int): android.app.PendingIntent {
            val startIntent = Intent(context, ScheduleReceiver::class.java).setAction(action)
            return android.app.PendingIntent.getBroadcast(
                context, requestCode, startIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )
        }
        val startTime = maxOf(startAt, now + 1000L)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarm.setExactAndAllowWhileIdle(
                    android.app.AlarmManager.RTC_WAKEUP, startTime, pending(ACTION_START, 8101)
                )
                alarm.setExactAndAllowWhileIdle(
                    android.app.AlarmManager.RTC_WAKEUP, endAt, pending(ACTION_STOP, 8102)
                )
            } else {
                alarm.setExact(android.app.AlarmManager.RTC_WAKEUP, startTime, pending(ACTION_START, 8101))
                alarm.setExact(android.app.AlarmManager.RTC_WAKEUP, endAt, pending(ACTION_STOP, 8102))
            }
            Log.i("RemoteCameraSchedule", "Saved schedule restored after boot.")
        } catch (error: SecurityException) {
            Log.e("RemoteCameraSchedule", "Could not restore exact schedule after boot.", error)
        }
    }

    companion object {
        const val ACTION_START = "jp.a09848281.remotecamera.SCHEDULE_START"
        const val ACTION_STOP = "jp.a09848281.remotecamera.SCHEDULE_STOP"
    }
}
