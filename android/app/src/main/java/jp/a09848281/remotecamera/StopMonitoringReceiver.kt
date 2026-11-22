package jp.a09848281.remotecamera

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.NotificationManager

/**
 * Stops the foreground monitor service without trying to start a new foreground
 * service from a notification action. onDestroy() performs RTC/camera/audio/lock cleanup.
 */
class StopMonitoringReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        stop(context)
    }

    companion object {
        private const val NOTIFICATION_ID = 7301

        fun stop(context: Context) {
            context.applicationContext
                .getSharedPreferences(AppConfig.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean("monitoringEnabled", false)
                .apply()

            context.applicationContext.stopService(
                Intent(context, MonitorService::class.java)
            )

            try {
                context.getSystemService(NotificationManager::class.java)
                    .cancel(NOTIFICATION_ID)
            } catch (_: Exception) {
                // Service teardown also removes its foreground notification.
            }
        }
    }
}
