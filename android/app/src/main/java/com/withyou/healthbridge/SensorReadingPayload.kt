package com.withyou.healthbridge

/**
 * The Android bridge uses the same small SensorReading contract as the web app.
 * `isSimulated` is always false for Health Connect data. Metadata explains the
 * summary window without including the raw records used to calculate it.
 */
data class SensorReadingPayload(
    val timestamp: String,
    val sensorType: String,
    val value: Double,
    val unit: String,
    val metadata: Map<String, Any>,
) {
    fun displayLine(): String = when (metadata["summary_kind"]) {
        "baseline" -> when (sensorType) {
            "steps" -> "30-day step baseline: ${value.toLong()} per day"
            "sleep" -> "30-day sleep baseline: ${"%.1f".format(value)} hours"
            "heart_rate" -> "30-day heart-rate baseline: ${value.toInt()} bpm"
            else -> "$sensorType baseline: $value $unit"
        }
        else -> when (sensorType) {
            "steps" -> "Steps today: ${value.toLong()}"
            "sleep" -> "Latest full sleep: ${"%.1f".format(value)} hours"
            "heart_rate" -> "Recent heart-rate average: ${value.toInt()} bpm"
            else -> "$sensorType: $value $unit"
        }
    }
}
