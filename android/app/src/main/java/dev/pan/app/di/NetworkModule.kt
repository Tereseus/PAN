package dev.pan.app.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.pan.app.network.HubLocator
import dev.pan.app.network.PanServerApi
import dev.pan.app.util.Constants
import dev.pan.app.vpn.RemoteAccessManager
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

/** Holds the user-configured device name so it can be sent on every request */
object DeviceNameHolder {
    @Volatile var name: String = android.os.Build.MODEL
}

/**
 * Holds the current PAN memory scope tag. Sent on every server request as
 * the `X-PAN-Scope` header so the server can route writes to the right
 * SQLCipher file. Default = "main" (canonical pan.db). Toggling incognito
 * mode in Settings flips this to "incognito" — the server then writes all
 * phone-originated events to a sibling pan.incognito.db that can be wiped
 * with one API call when the user toggles the mode back off.
 */
object ScopeHolder {
    @Volatile var scope: String = "main"
}

/** Holds the current Tailscale hostname (e.g. "pan-632ad7") so the server can track
 *  which tailnet node belongs to this device. Set by PanVpnService after connect. */
object TailscaleHostnameHolder {
    @Volatile var hostname: String = ""
}

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(ram: RemoteAccessManager, hub: HubLocator): OkHttpClient {
        return OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(Interceptor { chain ->
                var request = chain.request()

                // Resolve the hub PER REQUEST.
                //
                // This used to be `ram.getTailscaleBaseUrl()` alone, with
                // Retrofit's baseUrl (a hardcoded LAN IP) as the fallback. Two
                // failures came out of that:
                //   1. Retrofit captures baseUrl once, in a @Singleton. When the
                //      hub moved machines every request went to a dead host for
                //      the life of the process — the four polling loops in
                //      MainViewModel kept firing into nothing, which reads as a
                //      frozen UI.
                //   2. getTailscaleBaseUrl() returns null until tsnet assigns a
                //      proxy port, so whether the app got the proxy or the dead
                //      LAN constant depended on a startup race. That is why
                //      reopening the app sometimes "fixed" it.
                // HubLocator caches, so this is a map lookup on the hot path and
                // only probes after repeated failures.
                val base = hub.resolve(ram.getTailscaleBaseUrl())
                if (base != null) {
                    val b = base.toHttpUrl()
                    val newUrl = request.url.newBuilder()
                        .scheme(b.scheme).host(b.host).port(b.port).build()
                    request = request.newBuilder().url(newUrl).build()
                }

                val reqBuilder = request.newBuilder()
                    .addHeader("X-Device-Name", DeviceNameHolder.name)
                    .addHeader("X-Device-Id", android.os.Build.MODEL.lowercase().replace(" ", "-"))
                    .addHeader("X-PAN-Scope", ScopeHolder.scope)
                val tsHost = TailscaleHostnameHolder.hostname
                if (tsHost.isNotEmpty()) {
                    reqBuilder.addHeader("X-Tailscale-Hostname", tsHost)
                }
                request = reqBuilder.build()

                // Feed the outcome back so a wrong address self-corrects instead
                // of failing forever until the user reopens the app.
                try {
                    val response = chain.proceed(request)
                    if (response.isSuccessful) hub.reportSuccess() else hub.reportFailure()
                    response
                } catch (e: Exception) {
                    hub.reportFailure()
                    throw e
                }
            })
            .addInterceptor(HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BASIC
            })
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient): Retrofit {
        // Placeholder only. The interceptor above rewrites scheme/host/port on
        // every request, so this value is never actually contacted — Retrofit
        // just requires a syntactically valid baseUrl at build time. Do not put
        // a real address here again: a @Singleton baseUrl is exactly how the
        // phone ended up locked onto a dead host for nine days.
        return Retrofit.Builder()
            .baseUrl(Constants.PLACEHOLDER_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }

    @Provides
    @Singleton
    fun providePanServerApi(retrofit: Retrofit): PanServerApi {
        return retrofit.create(PanServerApi::class.java)
    }
}
