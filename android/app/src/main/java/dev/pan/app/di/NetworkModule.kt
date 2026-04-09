package dev.pan.app.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
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

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(ram: RemoteAccessManager): OkHttpClient {
        return OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(Interceptor { chain ->
                var request = chain.request()

                // Always route through Tailscale proxy when available
                val tailscaleUrl = ram.getTailscaleBaseUrl()
                if (tailscaleUrl != null) {
                    val tsBase = tailscaleUrl.toHttpUrl()
                    val newUrl = request.url.newBuilder()
                        .scheme(tsBase.scheme)
                        .host(tsBase.host)
                        .port(tsBase.port)
                        .build()
                    request = request.newBuilder().url(newUrl).build()
                }

                request = request.newBuilder()
                    .addHeader("X-Device-Name", DeviceNameHolder.name)
                    .addHeader("X-Device-Id", android.os.Build.MODEL.lowercase().replace(" ", "-"))
                    .addHeader("X-PAN-Scope", ScopeHolder.scope)
                    .build()
                chain.proceed(request)
            })
            .addInterceptor(HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BASIC
            })
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient): Retrofit {
        return Retrofit.Builder()
            .baseUrl(Constants.DEFAULT_SERVER_URL)
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
