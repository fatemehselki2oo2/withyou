package com.withyou.healthbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class HealthSyncCoordinatorTest {
    private fun payload(
        value: Double,
        timestamp: String = "2026-09-27T12:00:00Z",
        windowStart: String = "2026-08-28T12:00:00Z",
    ) = SensorReadingPayload(
        timestamp = timestamp,
        sensorType = "steps",
        value = value,
        unit = "count",
        metadata = mapOf(
            "provider" to "health_connect",
            "summary_kind" to "current",
            "window_start" to windowStart,
            "window_end" to timestamp,
            "raw_history_uploaded" to false,
        ),
    )

    @Test
    fun fingerprintIgnoresCalculationTimesWhenSummaryIsUnchanged() {
        val first = summaryFingerprint(listOf(payload(4_200.0)))
        val later = summaryFingerprint(listOf(payload(
            value = 4_200.0,
            timestamp = "2026-09-27T12:01:00Z",
            windowStart = "2026-08-28T12:01:00Z",
        )))

        assertEquals(first, later)
    }

    @Test
    fun fingerprintChangesWhenCompactSummaryValueChanges() {
        assertNotEquals(
            summaryFingerprint(listOf(payload(4_200.0))),
            summaryFingerprint(listOf(payload(4_260.0))),
        )
    }
}
