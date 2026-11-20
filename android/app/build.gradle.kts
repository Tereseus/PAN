import java.net.URI
import java.security.MessageDigest

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
        versionCode = 175
        versionName = "0.5.46"
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
// ΠAN's voice is part of the app (the owner, 2026-11-19). It was a 129 MB download on first
// start; on the car unit that left the voice on disk and the Android voice speaking. The build
// fetches the same file the app used to fetch (once, kept in android/.voice-cache, checked
// against its sha256) and puts the seven files the voice needs into the app's assets. They are
// not in git: one of them is 78 MB.
val voiceName = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
val voiceUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$voiceName.tar.bz2"
val voiceSha256 = "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427"
val voiceFiles = listOf("text_encoder.int8.onnx", "duration_predictor.int8.onnx", "vector_estimator.int8.onnx",
    "vocoder.int8.onnx", "voice.bin", "tts.json", "unicode_indexer.bin", "LICENSE")
val fetchVoice by tasks.registering {
    val out = layout.projectDirectory.dir("src/main/assets/voices/supertonic3").asFile
    val cache = rootProject.layout.projectDirectory.file(".voice-cache/$voiceName.tar.bz2").asFile
    outputs.dir(out)
    onlyIf { voiceFiles.any { !File(out, it).exists() } }
    doLast {
        fun sha(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { input ->
                val buf = ByteArray(1 shl 20)
                while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
        if (!cache.exists() || sha(cache) != voiceSha256) {
            cache.parentFile.mkdirs()
            logger.lifecycle("Fetching PAN's voice (129 MB, once): $voiceUrl")
            URI(voiceUrl).toURL().openStream().use { input -> cache.outputStream().use { input.copyTo(it) } }
        }
        val got = sha(cache)
        check(got == voiceSha256) { "PAN's voice file is not the one expected: sha256 $got, want $voiceSha256 (${cache.path})" }
        copy {
            from(tarTree(resources.bzip2(cache))) {
                include(voiceFiles.map { "$voiceName/$it" })
                eachFile { path = name }
                includeEmptyDirs = false
            }
            into(out)
        }
        voiceFiles.forEach { check(File(out, it).exists()) { "PAN's voice file has no $it" } }
    }
}
tasks.named("preBuild") { dependsOn(fetchVoice) }

// The models that hear are part of the app too (2026-11-19). They were a 107 MB download from
// two outside sites on the first tap of the mic, on any network, with "listening" on screen
// while nothing could be heard yet, and a deaf mic if it failed. Same way as the voice: fetched
// once by the build, each file checked against its sha256, put in the assets, not in git. The
// app copies them to its own folder the first time the mic is turned on (stt/SherpaStreamingStt).
val speechRepo = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main"
val speechFiles = mapOf(
    "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to ("$speechRepo/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1"),
    "decoder-epoch-99-avg-1-chunk-16-left-128.onnx" to ("$speechRepo/decoder-epoch-99-avg-1-chunk-16-left-128.onnx" to "7bf787f90b194b307e5a4ad6a34fadb4e748304c35f78a8d66358a05b13ee6ef"),
    "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to ("$speechRepo/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297"),
    "tokens.txt" to ("$speechRepo/tokens.txt" to "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb"),
    "silero_vad.onnx" to ("https://huggingface.co/csukuangfj/vad/resolve/main/silero_vad.onnx" to "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"),
    "smart-turn-v3.2-gpu.onnx" to ("https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-gpu.onnx" to "ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be"),
)
val fetchSpeech by tasks.registering {
    val out = layout.projectDirectory.dir("src/main/assets/asr").asFile
    val cache = rootProject.layout.projectDirectory.dir(".voice-cache/asr").asFile
    outputs.dir(out)
    onlyIf { speechFiles.keys.any { !File(out, it).exists() } }
    doLast {
        fun sha(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { input ->
                val buf = ByteArray(1 shl 20)
                while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
        cache.mkdirs(); out.mkdirs()
        for ((name, from) in speechFiles) {
            val (url, want) = from
            val kept = File(cache, name)
            if (!kept.exists() || sha(kept) != want) {
                logger.lifecycle("Fetching a speech model file (once): $name")
                URI(url).toURL().openStream().use { input -> kept.outputStream().use { input.copyTo(it) } }
            }
            val got = sha(kept)
            check(got == want) { "The speech model file $name is not the one expected: sha256 $got, want $want (${kept.path})" }
            kept.copyTo(File(out, name), overwrite = true)
        }
    }
}
tasks.named("preBuild") { dependsOn(fetchSpeech) }

// The voice's models are stored as they are: they do not compress, and stored files are read
// faster at start.
android.androidResources {
    noCompress += listOf("onnx")
}

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
