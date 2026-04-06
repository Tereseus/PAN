package dev.pan.app

import android.app.Application
import dev.pan.app.network.LogShipper
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class PanApplication : Application() {

    @Inject lateinit var logShipper: LogShipper

    override fun onCreate() {
        super.onCreate()

        // Catch uncaught exceptions and ship to PAN server before crashing
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                logShipper.error("crash", "FATAL: ${throwable::class.simpleName}: ${throwable.message}",
                    mapOf("stack" to (throwable.stackTraceToString().take(1500)),
                          "thread" to thread.name))
                logShipper.stop() // force flush before death
                Thread.sleep(500) // brief window for flush to complete
            } catch (_: Exception) {}
            defaultHandler?.uncaughtException(thread, throwable)
        }
    }
}
