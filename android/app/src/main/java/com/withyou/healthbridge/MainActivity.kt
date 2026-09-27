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
 * A deliberately small helper screen: grant access, then tap once to sync
 * current and 30-day baseline summaries.
 * There is no background service, account system, or automatic upload.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var healthRepository: HealthConnectRepository
    private val apiClient = WithYouApiClient()

    private lateinit var statusText: TextView
    private lateinit var statusLabelText: TextView
    private lateinit var statusDetailText: TextView
    private lateinit var resultsText: TextView
    private lateinit var requestAccessButton: Button
    private lateinit var syncButton: Button
    private lateinit var installButton: Button
    private lateinit var settingsButton: Button
    private lateinit var returnButton: Button
    private var pendingWebConnect = false
    private var autoSyncAfterPermission = false
    private var returnToWebAfterSync = false
    private var syncInProgress = false

    private val permissionLauncher = registerForActivityResult(
        HealthConnectRepository.permissionContract(),
    ) { granted ->
        val allGranted = granted.containsAll(HealthConnectRepository.REQUIRED_PERMISSIONS)
        if (allGranted) {
            showPermissionsReady()
        } else {
            showPermissionNeeded("Allow steps, sleep, and heart rate so WithYou can create the summaries you selected.")
        }
        if (allGranted && autoSyncAfterPermission) {
            autoSyncAfterPermission = false
            syncSummaries()
        } else if (!allGranted) {
            autoSyncAfterPermission = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        healthRepository = HealthConnectRepository(applicationContext)
        statusLabelText = findViewById(R.id.statusLabelText)
        statusText = findViewById(R.id.statusText)
        statusDetailText = findViewById(R.id.statusDetailText)
        resultsText = findViewById(R.id.resultsText)
        requestAccessButton = findViewById(R.id.requestAccessButton)
        syncButton = findViewById(R.id.syncButton)
        installButton = findViewById(R.id.installButton)
        settingsButton = findViewById(R.id.settingsButton)
        returnButton = findViewById(R.id.returnButton)
        acceptWebConnectIntent(intent)

        requestAccessButton.setOnClickListener {
            permissionLauncher.launch(HealthConnectRepository.REQUIRED_PERMISSIONS)
        }
        syncButton.setOnClickListener { syncSummaries() }
        installButton.setOnClickListener { openHealthConnectStorePage() }
        settingsButton.setOnClickListener { openHealthPermissions() }
        returnButton.setOnClickListener { openWithYouWeb() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptWebConnectIntent(intent)
        refreshAvailabilityAndPermissions()
    }

    override fun onResume() {
        super.onResume()
        refreshAvailabilityAndPermissions()
    }

    private fun refreshAvailabilityAndPermissions() {
        when (healthRepository.sdkStatus) {
            HealthConnectClient.SDK_AVAILABLE -> {
                installButton.visibility = View.GONE
                settingsButton.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val granted = healthRepository.hasAllPermissions()
                    if (granted) {
                        showPermissionsReady()
                    } else {
                        showPermissionNeeded("Allow steps, sleep, and heart rate. You can change this later in Android settings.")
                    }
                    if (pendingWebConnect) {
                        pendingWebConnect = false
                        if (granted) {
                            syncSummaries()
                        } else {
                            autoSyncAfterPermission = true
                            statusLabelText.text = "HEALTH PERMISSIONS"
                            statusText.text = "Your permission is needed"
                            statusDetailText.text = "Android will ask which health information WithYou may read."
                            permissionLauncher.launch(HealthConnectRepository.REQUIRED_PERMISSIONS)
                        }
                    }
                }
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                showOnlyPrimaryAction(installButton)
                statusLabelText.text = "HEALTH CONNECT"
                statusText.text = "Health Connect needs an update"
                statusDetailText.text = "Install or update it, then come back here to continue."
                installButton.visibility = View.VISIBLE
                settingsButton.visibility = View.GONE
            }
            else -> {
                showOnlyPrimaryAction(null)
                statusLabelText.text = "NOT AVAILABLE"
                statusText.text = "Health Connect is not available on this phone"
                statusDetailText.text = "This helper requires a supported Android phone with Health Connect."
                settingsButton.visibility = View.GONE
            }
        }
    }

    private fun syncSummaries() {
        if (syncInProgress) return
        syncInProgress = true
        requestAccessButton.isEnabled = false
        syncButton.isEnabled = false
        showOnlyPrimaryAction(null)
        settingsButton.isEnabled = false
        statusLabelText.text = "SYNCING…"
        statusText.text = "Preparing your health summaries"
        statusDetailText.text = "Keep this helper open for a moment."

        lifecycleScope.launch {
            try {
                if (!healthRepository.hasAllPermissions()) {
                    showPermissionNeeded("Health access changed. Allow steps, sleep, and heart rate before syncing.")
                    return@launch
                }

                val summaries = healthRepository.readRecentSummaries()
                if (summaries.isEmpty()) {
                    statusLabelText.text = "NO RECENT DATA"
                    statusText.text = "No health summaries were found"
                    statusDetailText.text = "Check that Samsung Health or another health app is sharing recent data with Health Connect."
                    resultsText.text = "Nothing was shared with WithYou."
                    showOnlyPrimaryAction(syncButton)
                    return@launch
                }

                val uploaded = apiClient.upload(summaries)
                statusLabelText.text = "SYNCED SUCCESSFULLY"
                statusText.text = "Your health summaries are ready in WithYou"
                statusDetailText.text = "$uploaded compact summaries were shared. Your detailed health history stayed in Health Connect."
                resultsText.text = summaries.joinToString(separator = "\n") { "• ${it.displayLine()}" }
                showOnlyPrimaryAction(returnButton)
                if (returnToWebAfterSync) {
                    returnToWebAfterSync = false
                    openWithYouWeb()
                }
            } catch (error: Exception) {
                statusLabelText.text = "SYNC NEEDS ATTENTION"
                statusText.text = "We couldn’t finish syncing"
                statusDetailText.text = "Check your internet connection and health permissions, then try again."
                resultsText.text = "Your detailed health history was not shared."
                showOnlyPrimaryAction(syncButton)
            } finally {
                syncInProgress = false
                requestAccessButton.isEnabled = true
                // Permission can be revoked from Settings at any time, including
                // while this Activity is alive, so re-check instead of assuming.
                syncButton.isEnabled = healthRepository.hasAllPermissions()
                settingsButton.isEnabled = true
            }
        }
    }

    private fun showPermissionNeeded(detail: String) {
        statusLabelText.text = "HEALTH PERMISSIONS"
        statusText.text = "Permission needed"
        statusDetailText.text = detail
        showOnlyPrimaryAction(requestAccessButton)
        settingsButton.visibility = View.VISIBLE
    }

    private fun showPermissionsReady() {
        statusLabelText.text = "PERMISSIONS READY"
        statusText.text = "Health permissions are ready"
        statusDetailText.text = "Sync when you are ready. WithYou only receives compact summaries."
        showOnlyPrimaryAction(syncButton)
        settingsButton.visibility = View.VISIBLE
    }

    private fun showOnlyPrimaryAction(button: Button?) {
        requestAccessButton.visibility = if (button === requestAccessButton) View.VISIBLE else View.GONE
        syncButton.visibility = if (button === syncButton) View.VISIBLE else View.GONE
        installButton.visibility = if (button === installButton) View.VISIBLE else View.GONE
        returnButton.visibility = if (button === returnButton) View.VISIBLE else View.GONE
    }

    private fun acceptWebConnectIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "withyou" && uri.host == "health" && uri.path == "/connect") {
            pendingWebConnect = true
            returnToWebAfterSync = true
        }
    }

    private fun openWithYouWeb() {
        val uri = Uri.parse(BuildConfig.WITHYOU_WEB_URL)
            .buildUpon()
            .appendQueryParameter("health_sync", "complete")
            .build()
        startActivity(Intent(Intent.ACTION_VIEW, uri))
    }

    private fun openHealthPermissions() {
        val appPermissionsIntent = Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS")
            .putExtra(Intent.EXTRA_PACKAGE_NAME, packageName)
        val generalSettingsIntent = Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        val opened = startFirstAvailable(appPermissionsIntent, generalSettingsIntent)
        if (!opened) {
            statusLabelText.text = "ANDROID SETTINGS"
            statusText.text = "Open Health Connect in Settings"
            statusDetailText.text = "Go to Settings → Security and privacy → Health Connect → App permissions."
        }
    }

    private fun startFirstAvailable(vararg intents: Intent): Boolean {
        for (intent in intents) {
            try {
                if (intent.resolveActivity(packageManager) != null) {
                    startActivity(intent)
                    return true
                }
            } catch (_: ActivityNotFoundException) {
                // Try the next supported Android path.
            }
        }
        return false
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
