package jp.a09848281.remotecamera

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.Calendar

object MonitorSchedule {
    const val ACTION_DAILY_START = "jp.a09848281.remotecamera.SCHEDULE_START"
    const val ACTION_DAILY_END = "jp.a09848281.remotecamera.SCHEDULE_END"
    private const val PREFS = "remote_camera_web2_prefs"

    fun scheduleDaily(context: Context, start: String, end: String) {
        require(validTime(start) && validTime(end)) { "開始・終了時刻は HH:mm 形式で指定してください。" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("dailyStartTime", start)
            .putString("dailyEndTime", end)
            .putBoolean("dailyScheduleEnabled", true)
            .apply()
        scheduleNext(context, ACTION_DAILY_START)
        scheduleNext(context, ACTION_DAILY_END)
    }

    fun cancel(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putBoolean("dailyScheduleEnabled", false).apply()
        cancelAction(context, ACTION_DAILY_START, 7302)
        cancelAction(context, ACTION_DAILY_END, 7303)
    }

    internal fun scheduleNext(context: Context, action: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("dailyScheduleEnabled", false)) return
        val time = prefs.getString(
            if (action == ACTION_DAILY_START) "dailyStartTime" else "dailyEndTime", ""
        ) ?: return
        if (!validTime(time)) return
        val parts = time.split(":")
        val now = Calendar.getInstance()
        val alarmAt = (now.clone() as Calendar).apply {
            set(Calendar.HOUR_OF_DAY, parts[0].toInt())
            set(Calendar.MINUTE, parts[1].toInt())
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (timeInMillis <= now.timeInMillis) add(Calendar.DAY_OF_YEAR, 1)
        }
        val requestCode = if (action == ACTION_DAILY_START) 7302 else 7303
        val intent = Intent(context, MonitorScheduleReceiver::class.java).setAction(action)
        val pending = PendingIntent.getBroadcast(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarmAt.timeInMillis, pending)
    }

    private fun cancelAction(context: Context, action: String, requestCode: Int) {
        val intent = Intent(context, MonitorScheduleReceiver::class.java).setAction(action)
        val pending = PendingIntent.getBroadcast(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending)
        pending.cancel()
    }

    private fun validTime(value: String): Boolean =
        Regex("^(?:[01]\\d|2[0-3]):[0-5]\\d$").matches(value)
}

class MonitorScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val prefs = context.getSharedPreferences("remote_camera_web2_prefs", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("dailyScheduleEnabled", false)) return
        when (action) {
            MonitorSchedule.ACTION_DAILY_START -> {
                val gasUrl = prefs.getString("gasUrl", "") ?: ""
                if (gasUrl.startsWith("https://script.google.com/macros/s/") && gasUrl.endsWith("/exec")) {
                    val start = Intent(context, MonitorService::class.java).apply {
                        this.action = MonitorService.ACTION_START
                        putExtra(MonitorService.EXTRA_GAS_URL, gasUrl)
                        putExtra(
                            MonitorService.EXTRA_POLL_INTERVAL_SECONDS,
                            prefs.getInt("pollIntervalSeconds", AppConfig.POLL_SECONDS.toInt())
                        )
                    }
                    try {
                        ContextCompat.startForegroundService(context, start)
                    } catch (error: Exception) {
                        Log.e("RemoteCameraSchedule", "Scheduled start rejected", error)
                    }
                } else {
                    Log.w("RemoteCameraSchedule", "Scheduled start skipped: GAS URL is not configured")
                }
                MonitorSchedule.scheduleNext(context, MonitorSchedule.ACTION_DAILY_START)
            }
            MonitorSchedule.ACTION_DAILY_END -> {
                context.stopService(Intent(context, MonitorService::class.java))
                prefs.edit().putBoolean("monitoringEnabled", false).apply()
                MonitorSchedule.scheduleNext(context, MonitorSchedule.ACTION_DAILY_END)
            }
        }
    }
}
