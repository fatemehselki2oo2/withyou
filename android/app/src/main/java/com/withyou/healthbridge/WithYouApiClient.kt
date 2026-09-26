package com.withyou.healthbridge

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Sends only already-normalized summaries to the existing FastAPI endpoint. */
class WithYouApiClient(private val baseUrl: String = BuildConfig.WITHYOU_API_BASE_URL) {
    suspend fun upload(readings: List<SensorReadingPayload>): Int = withContext(Dispatchers.IO) {
        readings.forEach { uploadOne(it) }
        readings.size
    }

    private fun uploadOne(reading: SensorReadingPayload) {
        val connection = URL("${baseUrl.trimEnd('/')}/api/sensors/readings")
            .openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")

            val body = JSONObject()
                .put("timestamp", reading.timestamp)
                .put("source", "watch")
                .put("sensor_type", reading.sensorType)
                .put("value", reading.value)
                .put("unit", reading.unit)
                .put("is_simulated", false)
                .put("metadata", JSONObject(reading.metadata))
                .toString()

            connection.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(body) }
            if (connection.responseCode !in 200..299) {
                val detail = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                error("WithYou API returned ${connection.responseCode}${if (detail.isBlank()) "." else ": $detail"}")
            }
            connection.inputStream.close()
        } finally {
            connection.disconnect()
        }
    }
}
