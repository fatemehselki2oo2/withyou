plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val withYouApiBaseUrl = providers.gradleProperty("WITHYOU_API_BASE_URL")
    .orElse(providers.environmentVariable("WITHYOU_API_BASE_URL"))
    .orElse("https://withyou-1g5l.onrender.com")

android {
    namespace = "com.withyou.healthbridge"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.withyou.healthbridge"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // This is a public backend URL, not a secret. Never put API keys here.
        buildConfigField("String", "WITHYOU_API_BASE_URL", "\"${withYouApiBaseUrl.get()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
