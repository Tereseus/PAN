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
        versionCode = 147
        versionName = "0.5.18"
        ndk {
            // Phones are arm64 â€” ship only that ABI. Drops the x86/x86_64/armeabi-v7a
            // copies of sherpa-onnx (Piper), onnxruntime, and gojni (Tailscale): ~100 MB.
            abiFilters += "arm64-v8a"
        }
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

    testOptions {
        unitTests.all {
            // SmartTurnModelTest needs the 32 MB fp32 model, which is not in the repo.
            // Point SMARTTURN_MODEL at it to run that test; without it, it skips.
            it.systemProperty("smartturn.model", System.getenv("SMARTTURN_MODEL") ?: "")
        }
    }

    buildFeatures {
        compose = true
        // Required so UpdateChecker can read BuildConfig.VERSION_CODE / APPLICATION_ID
        // at runtime to decide whether the server has a newer APK to install.
        buildConfig = true
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

    // CameraX â€” headless photo capture for vision commands
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    // PAN Link pairing scanner (ScanPairActivity): camera preview, and ZXing to read the QR (Apache 2.0).
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.zxing:core:3.5.3")

    // MediaPipe (bundles 1-2GB model) and llama.cpp REMOVED â€” not needed
    // implementation("com.google.mediapipe:tasks-genai:0.10.33")
    // implementation(project(":llama-lib"))

    // Piper TTS â€” high-quality on-device text-to-speech via sherpa-onnx
    implementation(files("libs/sherpa-onnx.aar"))

    // Smart Turn end-of-turn model (stt/SmartTurn.kt). sherpa-onnx links its own
    // onnxruntime STATICALLY into libsherpa-onnx-jni.so on arm64 and exposes no Java
    // API for running other models, so a general ONNX runner has to come from here.
    // No .so name clash: sherpa ships no separate libonnxruntime.so for arm64.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.30.0")
    // YAMNet music detection (stt/MusicDetector.kt). Apache 2.0. LiteRT is TensorFlow Lite
    // under its new name: same org.tensorflow.lite.Interpreter, same libtensorflowlite_jni.so.
    // org.tensorflow:tensorflow-lite stops at 2.16.1, whose library is 4 KB aligned and fails
    // Android's 16 KB page size check; LiteRT 1.4 is built 16 KB aligned.
    implementation("com.google.ai.edge.litert:litert:1.4.2")

    // JVM unit tests: Kotlin Whisper features vs the Python reference, and the real
    // model through the desktop build of onnxruntime (same ai.onnxruntime API).
    //
    // Pinned OLDER than the phone's 1.30.0 on purpose. Windows builds of ORT made
    // with VS 17.10+ need msvcp140.dll >= 14.40, but the test JVM is Android Studio's
    // JBR, which loads its own msvcp140.dll 14.29 first - and 1.30 then crashes the
    // JVM with an access violation inside msvcp140 while creating OrtEnvironment.
    // Desktop-only: Android links its own C++ runtime and is unaffected.
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.microsoft.onnxruntime:onnxruntime:1.18.0")

    // PAN Remote Access â€” embedded Tailscale tsnet (gomobile AAR)
    implementation(files("libs/panvpn.aar"))
}

// The Android onnxruntime's natives are arm64-only and cannot load on the desktop
// JVM that runs unit tests. The desktop artifact above provides the identical
// ai.onnxruntime API, so keep only that one on the unit-test runtime classpath.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}

// Native libraries and 16 KB pages (Android 15 and later; Google Play requires it for apps
// that target API 35 and up). Two things must hold:
//  1. every .so has 16 KB aligned LOAD segments. Prebuilt ones must be versions built that
//     way; our own are linked with -z max-page-size=16384 (pan-vpn/build-aar.sh,
//     panmt/CMakeLists.txt) because NDK r27 still defaults to 4 KB.
//  2. a .so stored uncompressed in the APK sits at a 16 KB offset. AGP 8.5.1 and later does
//     that by itself.
// useLegacyPackaging = true compresses the libraries, so 2 does not apply, and the APK the
// hub hands out stays near 73 MB instead of about 125 MB. Either value passes the check.
android.packaging {
    jniLibs {
        useLegacyPackaging = true
        // abiFilters already ships arm64 only, but native libs are MERGED before
        // that filter applies - and sherpa-onnx and onnxruntime-android both carry
        // lib/x86/libonnxruntime.so, which fails the merge. Nothing but arm64 is
        // shipped anyway, so drop the other ABIs here, where the clash happens.
        excludes += listOf("lib/x86/**", "lib/x86_64/**", "lib/armeabi-v7a/**")
    }
}
