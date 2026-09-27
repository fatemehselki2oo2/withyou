package com.withyou.healthbridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId
import kotlin.math.sqrt

/**
 * All Health Connect access lives here so the Activity stays easy to read.
 *
 * Important privacy boundary: raw records are held in memory only while this
 * foreground sync computes summaries. They are never returned to the UI,
 * written to disk, or sent to the WithYou backend.
 */
class HealthConnectRepository(private val context: Context) {
    companion object {
        const val PROVIDER_PACKAGE_NAME = "com.google.android.apps.healthdata"

        private const val BASELINE_DAYS = 30L
        private const val RECENT_HEART_RATE_HOURS = 24L
        private const val SLEEP_FRAGMENT_GAP_MINUTES = 60L
        private const val MIN_COMPLETED_SLEEP_MINUTES = 30L
        private const val MAX_COMPLETED_SLEEP_HOURS = 24L

        val REQUIRED_PERMISSIONS = setOf(
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
        )

        fun permissionContract() = PermissionController.createRequestPermissionResultContract()
    }

    private data class NumericStats(
        val count: Int,
        val average: Double,
        val minimum: Double,
        val maximum: Double,
        val standardDeviation: Double,
    )

    private class StatsAccumulator {
        private var sum = 0.0
        private var sumOfSquares = 0.0
        private var minimum = Double.POSITIVE_INFINITY
        private var maximum = Double.NEGATIVE_INFINITY
        var count = 0
            private set

        fun add(value: Double) {
            count += 1
            sum += value
            sumOfSquares += value * value
            minimum = minOf(minimum, value)
            maximum = maxOf(maximum, value)
        }

        fun finish(): NumericStats? {
            if (count == 0) return null
            val average = sum / count
            val variance = maxOf(0.0, sumOfSquares / count - average * average)
            return NumericStats(count, average, minimum, maximum, sqrt(variance))
        }
    }

    private data class SleepEpisode(
        val startTime: Instant,
        val endTime: Instant,
        val mergedRecordCount: Int,
    ) {
        val hours: Double
            get() = Duration.between(startTime, endTime).toMinutes() / 60.0
    }

    private data class HeartRateSummaries(
        val current: SensorReadingPayload?,
        val baseline: SensorReadingPayload?,
    )

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
        val zone = ZoneId.systemDefault()
        val todayStartLocal = LocalDate.now(zone).atStartOfDay()
        val baselineStartLocal = todayStartLocal.minusDays(BASELINE_DAYS)
        val todayStart = todayStartLocal.atZone(zone).toInstant()
        val stepBaselineStart = baselineStartLocal.atZone(zone).toInstant()
        val historyBaselineStart = now.minus(Duration.ofDays(BASELINE_DAYS))

        // Read sleep once. The extra day includes a session that began just
        // before the 30-day boundary and ended inside the baseline window.
        val sleepEpisodes = readCompletedSleepEpisodes(
            start = historyBaselineStart.minus(Duration.ofDays(1)),
            end = now,
        )
        val heartRate = readHeartRateSummaries(historyBaselineStart, now)

        return listOfNotNull(
            readStepsToday(todayStart, now),
            readStepsBaseline(baselineStartLocal, todayStartLocal, stepBaselineStart, todayStart, now),
            latestSleepSummary(sleepEpisodes),
            sleepBaselineSummary(sleepEpisodes, historyBaselineStart, now),
            heartRate.current,
            heartRate.baseline,
        )
    }

    private suspend fun readStepsToday(start: Instant, now: Instant): SensorReadingPayload? {
        // aggregate() is preferred for cumulative steps because Health Connect
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
            metadata = summaryMetadata("current", "today", start, now),
        )
    }

    private suspend fun readStepsBaseline(
        startLocal: java.time.LocalDateTime,
        endLocal: java.time.LocalDateTime,
        start: Instant,
        end: Instant,
        now: Instant,
    ): SensorReadingPayload? {
        // Calendar-day buckets respect local 23/24/25-hour days around daylight
        // saving changes. Empty days are omitted by Health Connect and are not
        // treated as zero, since they may simply mean the provider did not sync.
        val buckets = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = setOf(StepsRecord.COUNT_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(startLocal, endLocal),
                timeRangeSlicer = Period.ofDays(1),
            ),
        )
        val stats = statsOf(buckets.mapNotNull { it.result[StepsRecord.COUNT_TOTAL]?.toDouble() })
            ?: return null

        return SensorReadingPayload(
            timestamp = now.toString(),
            sensorType = "steps",
            value = stats.average,
            unit = "count/day",
            metadata = summaryMetadata("baseline", "30_day_daily_average", start, end) + mapOf(
                "requested_days" to BASELINE_DAYS,
                "days_with_data" to stats.count,
                "minimum_daily_steps" to stats.minimum,
                "maximum_daily_steps" to stats.maximum,
                "standard_deviation" to stats.standardDeviation,
            ),
        )
    }

    private suspend fun readCompletedSleepEpisodes(
        start: Instant,
        end: Instant,
    ): List<SleepEpisode> {
        val sessions = mutableListOf<SleepSessionRecord>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = SleepSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageToken = pageToken,
                ),
            )
            // SleepSessionRecord's parent interval represents the full session;
            // its stages are deliberately not treated as separate sleeps.
            sessions += response.records.filter { !it.endTime.isAfter(end) }
            pageToken = response.pageToken
        } while (!pageToken.isNullOrEmpty())

        return mergeSleepSessions(sessions)
    }

    private fun mergeSleepSessions(sessions: List<SleepSessionRecord>): List<SleepEpisode> {
        if (sessions.isEmpty()) return emptyList()

        // Some providers expose adjacent parent records for one completed sleep.
        // Merge overlaps and gaps up to one hour before selecting the latest
        // episode, which avoids choosing a tiny final fragment as the full sleep.
        val sorted = sessions.sortedBy { it.startTime }
        val merged = mutableListOf<SleepEpisode>()
        var current = SleepEpisode(sorted.first().startTime, sorted.first().endTime, 1)

        sorted.drop(1).forEach { session ->
            val mergeBoundary = current.endTime.plus(Duration.ofMinutes(SLEEP_FRAGMENT_GAP_MINUTES))
            if (!session.startTime.isAfter(mergeBoundary)) {
                current = current.copy(
                    endTime = maxOf(current.endTime, session.endTime),
                    mergedRecordCount = current.mergedRecordCount + 1,
                )
            } else {
                merged += current
                current = SleepEpisode(session.startTime, session.endTime, 1)
            }
        }
        merged += current

        return merged.filter { episode ->
            val duration = Duration.between(episode.startTime, episode.endTime)
            duration >= Duration.ofMinutes(MIN_COMPLETED_SLEEP_MINUTES) &&
                duration <= Duration.ofHours(MAX_COMPLETED_SLEEP_HOURS)
        }
    }

    private fun latestSleepSummary(episodes: List<SleepEpisode>): SensorReadingPayload? {
        val latest = episodes.maxByOrNull { it.endTime } ?: return null
        return SensorReadingPayload(
            timestamp = latest.endTime.toString(),
            sensorType = "sleep",
            value = latest.hours,
            unit = "hours",
            metadata = summaryMetadata(
                "current",
                "latest_completed_full_session",
                latest.startTime,
                latest.endTime,
            ) + mapOf(
                "sleep_start" to latest.startTime.toString(),
                "wake_time" to latest.endTime.toString(),
                "merged_parent_record_count" to latest.mergedRecordCount,
                "selection_rule" to "completed_parent_sessions_merged",
            ),
        )
    }

    private fun sleepBaselineSummary(
        episodes: List<SleepEpisode>,
        baselineStart: Instant,
        now: Instant,
    ): SensorReadingPayload? {
        val baselineEpisodes = episodes.filter { episode ->
            !episode.endTime.isBefore(baselineStart) && !episode.endTime.isAfter(now)
        }
        val stats = statsOf(baselineEpisodes.map { it.hours }) ?: return null

        return SensorReadingPayload(
            timestamp = now.toString(),
            sensorType = "sleep",
            value = stats.average,
            unit = "hours/session",
            metadata = summaryMetadata("baseline", "30_day_completed_sleep_average", baselineStart, now) + mapOf(
                "requested_days" to BASELINE_DAYS,
                "completed_session_count" to stats.count,
                "minimum_hours" to stats.minimum,
                "maximum_hours" to stats.maximum,
                "standard_deviation" to stats.standardDeviation,
                "selection_rule" to "completed_parent_sessions_merged",
            ),
        )
    }

    private suspend fun readHeartRateSummaries(
        baselineStart: Instant,
        now: Instant,
    ): HeartRateSummaries {
        val recentStart = now.minus(Duration.ofHours(RECENT_HEART_RATE_HOURS))
        val baselineStats = StatsAccumulator()
        val currentStats = StatsAccumulator()
        var latestSampleTime: Instant? = null
        var pageToken: String? = null

        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = HeartRateRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(baselineStart, now),
                    pageToken = pageToken,
                ),
            )
            response.records.forEach { record ->
                record.samples.forEach { sample ->
                    val bpm = sample.beatsPerMinute.toDouble()
                    baselineStats.add(bpm)
                    if (!sample.time.isBefore(recentStart)) currentStats.add(bpm)
                    val previousLatest = latestSampleTime
                    if (previousLatest == null || sample.time > previousLatest) {
                        latestSampleTime = sample.time
                    }
                }
            }
            pageToken = response.pageToken
        } while (!pageToken.isNullOrEmpty())

        val current = currentStats.finish()?.let { stats ->
            SensorReadingPayload(
                timestamp = (latestSampleTime ?: now).toString(),
                sensorType = "heart_rate",
                value = stats.average,
                unit = "bpm",
                metadata = summaryMetadata("current", "last_24_hours", recentStart, now) +
                    stats.metadata("bpm"),
            )
        }
        val baseline = baselineStats.finish()?.let { stats ->
            SensorReadingPayload(
                timestamp = now.toString(),
                sensorType = "heart_rate",
                value = stats.average,
                unit = "bpm",
                metadata = summaryMetadata("baseline", "30_day_average", baselineStart, now) +
                    stats.metadata("bpm") + mapOf("requested_days" to BASELINE_DAYS),
            )
        }
        return HeartRateSummaries(current, baseline)
    }

    private fun NumericStats.metadata(suffix: String): Map<String, Any> = mapOf(
        "sample_count" to count,
        "minimum_$suffix" to minimum,
        "maximum_$suffix" to maximum,
        "standard_deviation" to standardDeviation,
    )

    private fun statsOf(values: List<Double>): NumericStats? {
        val accumulator = StatsAccumulator()
        values.forEach(accumulator::add)
        return accumulator.finish()
    }

    private fun summaryMetadata(
        summaryKind: String,
        label: String,
        start: Instant,
        end: Instant,
    ): Map<String, Any> = mapOf(
        "provider" to "health_connect",
        "summary_kind" to summaryKind,
        "summary" to label,
        "window_start" to start.toString(),
        "window_end" to end.toString(),
        "is_health_connect_summary" to true,
        "raw_history_uploaded" to false,
        // Health Connect may combine Samsung Health, phone, or other approved sources.
        "origin_scope" to "connected_health_apps",
    )
}
