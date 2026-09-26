package com.withyou.healthbridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * All Health Connect access lives here so the Activity stays easy to read.
 *
 * Important privacy boundary: raw records are used only long enough to compute
 * a recent summary. They are not returned to the UI, written to disk, or sent
 * to the WithYou backend.
 */
class HealthConnectRepository(private val context: Context) {
    companion object {
        const val PROVIDER_PACKAGE_NAME = "com.google.android.apps.healthdata"

        val REQUIRED_PERMISSIONS = setOf(
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
        )

        fun permissionContract() = PermissionController.createRequestPermissionResultContract()
    }

    val sdkStatus: Int
        get() = HealthConnectClient.getSdkStatus(context)

    private val client: HealthConnectClient by lazy {
        HealthConnectClient.getOrCreate(context)
    }

    suspend fun hasAllPermissions(): Boolean {
        if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) return false
        return client.permissionController.getGrantedPermissions().containsAll(REQUIRED_PERMISSIONS)
    }

    suspend fun readRecentSummaries(): List<SensorReadingPayload> {
        check(sdkStatus == HealthConnectClient.SDK_AVAILABLE) { "Health Connect is unavailable." }
        check(hasAllPermissions()) { "Health Connect read access has not been granted." }

        val now = Instant.now()
        return listOfNotNull(
            readStepsToday(now),
            readLatestSleep(now),
            readHeartRateSummary(now),
        )
    }

    private suspend fun readStepsToday(now: Instant): SensorReadingPayload? {
        val start = LocalDate.now()
            .atStartOfDay(ZoneId.systemDefault())
            .toInstant()

        // Health Connect recommends aggregate() for cumulative steps because it
        // deduplicates overlapping records from connected data sources.
        val result = client.aggregate(
            AggregateRequest(
                metrics = setOf(StepsRecord.COUNT_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(start, now),
            ),
        )
        val total = result[StepsRecord.COUNT_TOTAL] ?: return null

        return SensorReadingPayload(
            timestamp = now.toString(),
            sensorType = "steps",
            value = total.toDouble(),
            unit = "count",
            metadata = summaryMetadata("today", start, now),
        )
    }

    private suspend fun readLatestSleep(now: Instant): SensorReadingPayload? {
        val start = now.minus(Duration.ofHours(36))
        var pageToken: String? = null
        var latest: SleepSessionRecord? = null

        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = SleepSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, now),
                    pageToken = pageToken,
                ),
            )
            response.records.forEach { session ->
                if (latest == null || session.endTime > latest!!.endTime) latest = session
            }
            pageToken = response.pageToken
        } while (!pageToken.isNullOrEmpty())

        val session = latest ?: return null
        val hours = Duration.between(session.startTime, session.endTime).toMinutes() / 60.0
        return SensorReadingPayload(
            timestamp = session.endTime.toString(),
            sensorType = "sleep",
            value = hours.coerceIn(0.0, 24.0),
            unit = "hours",
            metadata = mapOf(
                "provider" to "health_connect",
                "summary" to "latest_completed_session",
                "sleep_start" to session.startTime.toString(),
                "wake_time" to session.endTime.toString(),
                "is_health_connect_summary" to true,
            ),
        )
    }

    private suspend fun readHeartRateSummary(now: Instant): SensorReadingPayload? {
        val start = now.minus(Duration.ofHours(24))
        var pageToken: String? = null
        var sampleCount = 0
        var sum = 0.0
        var minimum = Double.POSITIVE_INFINITY
        var maximum = Double.NEGATIVE_INFINITY
        var latestSampleTime: Instant? = null

        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = HeartRateRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, now),
                    pageToken = pageToken,
                ),
            )
            response.records.forEach { record ->
                record.samples.forEach { sample ->
                    val bpm = sample.beatsPerMinute.toDouble()
                    sampleCount += 1
                    sum += bpm
                    minimum = minOf(minimum, bpm)
                    maximum = maxOf(maximum, bpm)
                    val previousLatest = latestSampleTime
                    if (previousLatest == null || sample.time > previousLatest) {
                        latestSampleTime = sample.time
                    }
                }
            }
            pageToken = response.pageToken
        } while (!pageToken.isNullOrEmpty())

        if (sampleCount == 0) return null
        return SensorReadingPayload(
            timestamp = (latestSampleTime ?: now).toString(),
            sensorType = "heart_rate",
            value = sum / sampleCount,
            unit = "bpm",
            metadata = summaryMetadata("last_24_hours", start, now) + mapOf(
                "sample_count" to sampleCount,
                "minimum_bpm" to minimum,
                "maximum_bpm" to maximum,
            ),
        )
    }

    private fun summaryMetadata(label: String, start: Instant, end: Instant): Map<String, Any> = mapOf(
        "provider" to "health_connect",
        "summary" to label,
        "window_start" to start.toString(),
        "window_end" to end.toString(),
        "is_health_connect_summary" to true,
        // Health Connect may combine Samsung Health, phone, or other approved sources.
        "origin_scope" to "connected_health_apps",
    )
}
