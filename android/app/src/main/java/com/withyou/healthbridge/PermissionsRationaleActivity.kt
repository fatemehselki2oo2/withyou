package com.withyou.healthbridge

import android.os.Bundle
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity

/** Health Connect opens this plain-language privacy explanation from its UI. */
class PermissionsRationaleActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_permissions_rationale)
        findViewById<Button>(R.id.closeButton).setOnClickListener { finish() }
    }
}
