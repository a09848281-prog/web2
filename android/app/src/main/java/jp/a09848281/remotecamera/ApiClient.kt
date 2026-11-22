package jp.a09848281.remotecamera

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class ApiClient(private val gasUrl: String) {
    fun call(
        action: String,
        values: JSONObject = JSONObject(),
        connectTimeoutMs: Int = 15000,
        readTimeoutMs: Int = 20000
    ): JSONObject {
        require(
            gasUrl.startsWith("https://script.google.com/macros/s/") &&
                gasUrl.endsWith("/exec") &&
                !gasUrl.contains("GAS_EXEC_URL_HERE") &&
                !gasUrl.contains("PASTE_YOUR_DEPLOYMENT_ID")
        ) { "GASのウェブアプリ /exec URLが正しくありません。" }
        val payload = JSONObject(values.toString()).put("action", action)
        val body = "payload=" + URLEncoder.encode(payload.toString(), "UTF-8") + "&mode=json"
        val connection = URL(gasUrl).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = connectTimeoutMs.coerceIn(2000, 30000)
        connection.readTimeout = readTimeoutMs.coerceIn(3000, 30000)
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        connection.setRequestProperty("Accept", "application/json")
        try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val text = if (code in 300..399) {
                val location = connection.getHeaderField("Location")
                    ?: error("GAS redirect URLがありません。HTTP $code")
                val redirectUrl = URL(location)
                val redirectHost = redirectUrl.host.lowercase()
                require(
                    redirectUrl.protocol == "https" &&
                    (redirectHost == "script.googleusercontent.com" ||
                        redirectHost.endsWith(".googleusercontent.com"))
                ) { "GASから許可されていないリダイレクト先が返されました。" }
                connection.disconnect()
                val redirected = redirectUrl.openConnection() as HttpURLConnection
                redirected.connectTimeout = connectTimeoutMs.coerceIn(2000, 30000)
                redirected.readTimeout = readTimeoutMs.coerceIn(3000, 30000)
                try {
                    val stream = if (redirected.responseCode >= 400) redirected.errorStream else redirected.inputStream
                    BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
                } finally { redirected.disconnect() }
            } else {
                val stream = if (code >= 400) connection.errorStream else connection.inputStream
                BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
            }
            val result = JSONObject(text)
            if (!result.optBoolean("ok", false)) error(result.optString("error", "GAS APIエラー"))
            return result
        } finally {
            try { connection.disconnect() } catch (_: Exception) {}
        }
    }
}