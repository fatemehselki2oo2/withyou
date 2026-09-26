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
    fun displayLine(): String = when (sensorType) {
        "steps" -> "Steps today: ${value.toLong()}"
        "sleep" -> "Latest sleep: ${"%.1f".format(value)} hours"
        "heart_rate" -> "Recent heart-rate average: ${value.toInt()} bpm"
        else -> "$sensorType: $value $unit"
    }
}
