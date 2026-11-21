package jp.a09848281.remotecamera

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

class ScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            ACTION_START -> {
                val prefs = context.getSharedPreferences(AppConfig.PREFS, Context.MODE_PRIVATE)
                val gasUrl = prefs.getString("gasUrl", "") ?: ""
                if (!gasUrl.startsWith("https://script.google.com/macros/s/") || !gasUrl.endsWith("/exec")) {
                    Log.e("RemoteCameraSchedule", "Scheduled start skipped: GAS URL is unavailable.")
                    return
                }
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
                    Log.e("RemoteCameraSchedule", "Android rejected scheduled foreground-service start.", error)
                }
            }
            ACTION_STOP -> {
                try {
                    context.getSharedPreferences(AppConfig.PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean("monitoringEnabled", false).apply()
                    context.stopService(Intent(context, MonitorService::class.java))
                    Log.i("RemoteCameraSchedule", "Scheduled monitoring stop requested.")
                } catch (error: Exception) {
                    Log.e("RemoteCameraSchedule", "Scheduled monitoring stop failed.", error)
                }
            }
        }
    }

    companion object {
        const val ACTION_START = "jp.a09848281.remotecamera.SCHEDULE_START"
        const val ACTION_STOP = "jp.a09848281.remotecamera.SCHEDULE_STOP"
    }
}
