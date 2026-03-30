plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "dev.pan.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.pan.app"
        minSdk = 31
        targetSdk = 34
        versionCode = 2
        versionName = "0.3.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // Compose
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.activity)
    debugImplementation(libs.compose.ui.tooling)

    // Navigation
    implementation(libs.navigation.compose)

    // Lifecycle
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.service)

    // Hilt
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    // Room
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // Network
    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    // Coroutines
    implementation(libs.coroutines.android)

    // Core
    implementation(libs.core.ktx)

    // CameraX — headless photo capture for vision commands
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")

    // Vosk — offline speech recognition (no profanity filter, no audio focus steal)
    implementation("com.alphacephei:vosk-android:0.3.47")

    // On-device AI REMOVED — all AI goes through server (Cerebras/Gemini via Tailscale)
    // MediaPipe tasks-genai (1-2GB model), ML Kit GenAI, and llama.cpp all removed
    // Offline fallback uses tiny Qwen 0.6B classifier already bundled in assets
    // implementation("com.google.mlkit:genai-prompt:1.0.0-beta1")
    // implementation("com.google.mediapipe:tasks-genai:0.10.33")
    // implementation(project(":llama-lib"))

    // PAN Remote Access — embedded Tailscale tsnet (gomobile AAR)
    implementation(files("libs/panvpn.aar"))
}

// NDK for llama.cpp native code
android.packaging {
    jniLibs {
        useLegacyPackaging = true
    }
}
