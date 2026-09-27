package com.withyou.healthbridge

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * A deliberately small bridge screen: grant access, then tap once to sync
 * current and 30-day baseline summaries.
 * There is no background service, account system, or automatic upload.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var healthRepository: HealthConnectRepository
    private val apiClient = WithYouApiClient()

    private lateinit var statusText: TextView
    private lateinit var resultsText: TextView
    private lateinit var requestAccessButton: Button
    private lateinit var syncButton: Button
    private lateinit var installButton: Button

    private val permissionLauncher = registerForActivityResult(
        HealthConnectRepository.permissionContract(),
    ) { granted ->
        val allGranted = granted.containsAll(HealthConnectRepository.REQUIRED_PERMISSIONS)
        statusText.text = if (allGranted) {
            "Read access granted. You can sync recent summaries."
        } else {
            "Some access was not granted. Steps, sleep, and heart rate are all needed for this demo."
        }
        syncButton.isEnabled = allGranted
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        healthRepository = HealthConnectRepository(applicationContext)
        statusText = findViewById(R.id.statusText)
        resultsText = findViewById(R.id.resultsText)
        requestAccessButton = findViewById(R.id.requestAccessButton)
        syncButton = findViewById(R.id.syncButton)
        installButton = findViewById(R.id.installButton)

        requestAccessButton.setOnClickListener {
            permissionLauncher.launch(HealthConnectRepository.REQUIRED_PERMISSIONS)
        }
        syncButton.setOnClickListener { syncSummaries() }
        installButton.setOnClickListener { openHealthConnectStorePage() }
    }

    override fun onResume() {
        super.onResume()
        refreshAvailabilityAndPermissions()
    }

    private fun refreshAvailabilityAndPermissions() {
        when (healthRepository.sdkStatus) {
            HealthConnectClient.SDK_AVAILABLE -> {
                installButton.visibility = View.GONE
                requestAccessButton.isEnabled = true
                lifecycleScope.launch {
                    val granted = healthRepository.hasAllPermissions()
                    statusText.text = if (granted) {
                        "Health Connect is ready. Read access is granted."
                    } else {
                        "Health Connect is ready. Tap Request read access."
                    }
                    syncButton.isEnabled = granted
                }
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                statusText.text = "Health Connect needs to be installed or updated."
                setHealthButtonsEnabled(false)
                installButton.visibility = View.VISIBLE
            }
            else -> {
                statusText.text = "Health Connect is unavailable on this device. Android 9 or newer is required."
                setHealthButtonsEnabled(false)
                installButton.visibility = View.GONE
            }
        }
    }

    private fun syncSummaries() {
        requestAccessButton.isEnabled = false
        syncButton.isEnabled = false
        statusText.text = "Reading and summarizing on this phone…"

        lifecycleScope.launch {
            try {
                if (!healthRepository.hasAllPermissions()) {
                    statusText.text = "Access changed. Grant read access before syncing."
                    requestAccessButton.isEnabled = true
                    return@launch
                }

                val summaries = healthRepository.readRecentSummaries()
                if (summaries.isEmpty()) {
                    statusText.text = "No recent Health Connect data was available to sync."
                    resultsText.text = "Check that Samsung Health is writing data to Health Connect."
                    return@launch
                }

                val uploaded = apiClient.upload(summaries)
                statusText.text = "Connected. $uploaded compact Health Connect summaries were accepted by WithYou."
                resultsText.text = summaries.joinToString(separator = "\n") { "• ${it.displayLine()}" }
            } catch (error: Exception) {
                statusText.text = "Sync did not finish. Your raw Health Connect data was not uploaded."
                resultsText.text = error.message ?: "Unknown sync error."
            } finally {
                requestAccessButton.isEnabled = true
                // Permission can be revoked from Settings at any time, including
                // while this Activity is alive, so re-check instead of assuming.
                syncButton.isEnabled = healthRepository.hasAllPermissions()
            }
        }
    }

    private fun setHealthButtonsEnabled(enabled: Boolean) {
        requestAccessButton.isEnabled = enabled
        syncButton.isEnabled = enabled
    }

    private fun openHealthConnectStorePage() {
        val appId = HealthConnectRepository.PROVIDER_PACKAGE_NAME
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$appId")))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$appId")))
        }
    }
}
