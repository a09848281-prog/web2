package jp.a09848281.remotecamera

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.net.Uri
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import kotlin.math.roundToInt

class RemoteControlAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: RemoteControlAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun executeRemoteCommand(name: String, payload: JSONObject): String {
        when (name) {
            "remote_tap" -> dispatchPoint(payload, 80L)
            "remote_long_press" -> dispatchPoint(payload, 700L)
            "remote_swipe" -> dispatchSwipe(payload)
            "remote_back" -> globalAction(GLOBAL_ACTION_BACK)
            "remote_home" -> globalAction(GLOBAL_ACTION_HOME)
            "remote_recents" -> globalAction(GLOBAL_ACTION_RECENTS)
            "remote_notifications" -> globalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "remote_quick_settings" -> globalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "remote_text" -> setFocusedText(payload.optString("text", ""))
            "remote_open_app" -> openApp(payload.optString("app", ""))
            "remote_open_url" -> openUrl(payload.optString("url", ""))
            "remote_scroll_up" -> scrollFocused(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
            "remote_scroll_down" -> scrollFocused(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            else -> error("未対応の遠隔操作です：$name")
        }
        return "Androidで操作を受け付けました。"
    }

    private fun globalAction(action: Int) {
        check(performGlobalAction(action)) { "Androidがこのシステム操作を受け付けませんでした。" }
    }

    private fun dispatchPoint(payload: JSONObject, durationMs: Long) {
        val frameWidth = payload.optInt("width", 0)
        val frameHeight = payload.optInt("height", 0)
        require(frameWidth in 1..8192 && frameHeight in 1..8192) { "画面サイズを確認できません。" }
        val x = payload.optInt("x", -1)
        val y = payload.optInt("y", -1)
        require(x in 0 until frameWidth && y in 0 until frameHeight) { "操作位置が画面外です。" }
        val metrics = resources.displayMetrics
        val px = (x.toFloat() * metrics.widthPixels / frameWidth).coerceIn(0f, (metrics.widthPixels - 1).coerceAtLeast(0).toFloat())
        val py = (y.toFloat() * metrics.heightPixels / frameHeight).coerceIn(0f, (metrics.heightPixels - 1).coerceAtLeast(0).toFloat())
        dispatchPath(px, py, px, py, durationMs)
    }

    private fun dispatchSwipe(payload: JSONObject) {
        val frameWidth = payload.optInt("width", 0)
        val frameHeight = payload.optInt("height", 0)
        require(frameWidth in 1..8192 && frameHeight in 1..8192) { "画面サイズを確認できません。" }
        fun scaled(key: String, max: Int, actual: Int): Float {
            val value = payload.optInt(key, -1)
            require(value in 0 until max) { "スワイプ位置が画面外です。" }
            return (value.toFloat() * actual / max).coerceIn(0f, (actual - 1).coerceAtLeast(0).toFloat())
        }
        val metrics = resources.displayMetrics
        val sx = scaled("startX", frameWidth, metrics.widthPixels)
        val sy = scaled("startY", frameHeight, metrics.heightPixels)
        val ex = scaled("endX", frameWidth, metrics.widthPixels)
        val ey = scaled("endY", frameHeight, metrics.heightPixels)
        val duration = payload.optLong("durationMs", 250L).coerceIn(80L, 900L)
        dispatchPath(sx, sy, ex, ey, duration)
    }

    private fun dispatchPath(sx: Float, sy: Float, ex: Float, ey: Float, durationMs: Long) {
        val path = Path().apply {
            moveTo(sx, sy)
            lineTo(ex, ey)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs))
            .build()
        check(dispatchGesture(gesture, null, null)) { "Androidが画面ジェスチャーを受け付けませんでした。" }
    }

    private fun setFocusedText(raw: String) {
        val text = raw.filterNot { it.isISOControl() }.take(300)
        require(text.isNotEmpty()) { "入力する文字がありません。" }
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: error("Android側で入力欄を選択してください。")
        try {
            check(node.isEditable) { "選択中の項目は文字入力に対応していません。" }
            check(!node.isPassword) { "安全のためパスワード欄への遠隔入力はできません。" }
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            check(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                "選択中の入力欄が遠隔入力を受け付けませんでした。"
            }
        } finally {
            node.recycle()
        }
    }

    private fun openApp(raw: String) {
        val value = raw.trim().take(120)
        require(value.isNotBlank()) { "アプリ名を入力してください。" }
        val packageName = when (value.lowercase()) {
            "youtube", "ユーチューブ" -> "com.google.android.youtube"
            "line", "ライン" -> "jp.naver.line.android"
            "chrome", "クローム" -> "com.android.chrome"
            "settings", "設定" -> "com.android.settings"
            else -> value
        }
        require(packageName.matches(Regex("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+"))) {
            "アプリ名またはパッケージ名を確認してください。"
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
            ?: error("アプリを開けません。インストール状態またはパッケージ名を確認してください。")
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(launch)
    }

    private fun openUrl(raw: String) {
        val value = raw.trim().take(1500)
        require(value.length <= 1500 && Regex("^https?://[^\\s]+$", RegexOption.IGNORE_CASE).matches(value)) {
            "http:// または https:// から始まるURLを入力してください。"
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(value)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        check(intent.resolveActivity(packageManager) != null) { "URLを開くアプリが見つかりません。" }
        startActivity(intent)
    }

    private fun scrollFocused(action: Int) {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: rootInActiveWindow
            ?: error("操作できる画面がありません。")
        try {
            check(node.performAction(action)) { "選択中の画面はスクロール操作に対応していません。" }
        } finally {
            node.recycle()
        }
    }
}
