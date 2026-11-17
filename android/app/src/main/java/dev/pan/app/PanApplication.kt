package dev.pan.app

import android.app.Application
import dev.pan.app.data.DataRepository
import dev.pan.app.di.ScopeHolder
import dev.pan.app.network.LogShipper
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

@HiltAndroidApp
class PanApplication : Application() {

    @Inject lateinit var logShipper: LogShipper
    @Inject lateinit var dataRepository: DataRepository

    override fun onCreate() {
        super.onCreate()

        // Incognito first, before the service or anything else can send. On the first start after an
        // update from a build that kept the switch only in the settings table, read it from there once.
        val incognito = ScopeHolder.saved(this)
            ?: (runCatching { runBlocking(Dispatchers.IO) { dataRepository.getSetting("incognito_mode") } }.getOrNull() == "true")
        ScopeHolder.set(this, incognito)

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
