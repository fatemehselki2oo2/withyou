package com.withyou.healthbridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.IOException

class HealthSyncWorker(
    appContext: Context,
    workerParameters: WorkerParameters,
) : CoroutineWorker(appContext, workerParameters) {
    override suspend fun doWork(): Result {
        val repository = HealthConnectRepository(applicationContext)
        if (repository.sdkStatus != HealthConnectClient.SDK_AVAILABLE) return Result.success()
        if (!repository.hasAllPermissions() || !repository.hasBackgroundReadPermission()) {
            return Result.success()
        }

        return try {
            HealthSyncCoordinator(applicationContext, repository).sync()
            Result.success()
        } catch (_: IOException) {
            Result.retry()
        } catch (_: Exception) {
            // A revoked permission or unavailable provider should not create an
            // endless retry loop. Foreground resume will explain the state.
            Result.success()
        }
    }
}
