package com.withyou.healthbridge

import android.content.Context
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest
import java.time.Instant

sealed interface HealthSyncResult {
    val summaries: List<SensorReadingPayload>
    val checkedAt: Instant

    data class Uploaded(
        override val summaries: List<SensorReadingPayload>,
        override val checkedAt: Instant,
        val uploadedCount: Int,
    ) : HealthSyncResult

    data class Unchanged(
        override val summaries: List<SensorReadingPayload>,
        override val checkedAt: Instant,
    ) : HealthSyncResult

    data class NoData(
        override val checkedAt: Instant,
    ) : HealthSyncResult {
        override val summaries: List<SensorReadingPayload> = emptyList()
    }
}

/**
 * One privacy-preserving sync path shared by the Activity and WorkManager.
 * It stores only a hash of the last compact summaries so unchanged summaries
 * are not uploaded again. Raw Health Connect records never leave the repository.
 */
class HealthSyncCoordinator(
    context: Context,
    private val repository: HealthConnectRepository = HealthConnectRepository(context.applicationContext),
    private val apiClient: WithYouApiClient = WithYouApiClient(),
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    suspend fun sync(): HealthSyncResult = syncMutex.withLock {
        val checkedAt = Instant.now()
        val summaries = repository.readRecentSummaries()
        if (summaries.isEmpty()) return@withLock HealthSyncResult.NoData(checkedAt)

        val fingerprint = summaryFingerprint(summaries)
        if (fingerprint == preferences.getString(LAST_FINGERPRINT_KEY, null)) {
            return@withLock HealthSyncResult.Unchanged(summaries, checkedAt)
        }

        val uploaded = apiClient.upload(summaries)
        preferences.edit()
            .putString(LAST_FINGERPRINT_KEY, fingerprint)
            .putString(LAST_UPLOAD_AT_KEY, checkedAt.toString())
            .apply()
        HealthSyncResult.Uploaded(summaries, checkedAt, uploaded)
    }

    companion object {
        private const val PREFERENCES_NAME = "withyou_health_sync"
        private const val LAST_FINGERPRINT_KEY = "last_summary_fingerprint"
        private const val LAST_UPLOAD_AT_KEY = "last_upload_at"
        private val syncMutex = Mutex()
    }
}

private val VOLATILE_METADATA_KEYS = setOf("window_start", "window_end")

internal fun summaryFingerprint(summaries: List<SensorReadingPayload>): String {
    val canonical = summaries
        .sortedWith(compareBy({ it.sensorType }, { it.metadata["summary_kind"].toString() }))
        .joinToString(separator = "\n") { summary ->
            val metadata = summary.metadata.entries
                .filterNot { it.key in VOLATILE_METADATA_KEYS }
                .sortedBy { it.key }
                .joinToString(separator = ";") { (key, value) -> "$key=${canonicalValue(value)}" }
            "${summary.sensorType}|${summary.value.toBits()}|${summary.unit}|$metadata"
        }
    return MessageDigest.getInstance("SHA-256")
        .digest(canonical.toByteArray(Charsets.UTF_8))
        .joinToString(separator = "") { byte -> "%02x".format(byte) }
}

private fun canonicalValue(value: Any?): String = when (value) {
    is Double -> value.toBits().toString()
    is Float -> value.toBits().toString()
    else -> value.toString()
}
