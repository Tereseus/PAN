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

    // Google ML Kit GenAI — on-device Gemini Nano (backup)
    implementation("com.google.mlkit:genai-prompt:1.0.0-beta1")

    // Google AI Edge SDK — direct AICore access (backup)
    implementation("com.google.ai.edge.aicore:aicore:0.0.1-exp01")

    // llama.cpp for Android — local LLM inference (native ARM64 build)
    implementation(project(":llama-lib"))
}

// NDK for llama.cpp native code
android.packaging {
    jniLibs {
        useLegacyPackaging = true
    }
}
