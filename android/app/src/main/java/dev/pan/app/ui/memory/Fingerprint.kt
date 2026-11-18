package dev.pan.app.ui.memory

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal

/**
 * The lock on Memory. Always the device's own fingerprint (or face, where that is its biometric),
 * never the device's PIN or pattern: the owner's rule (2026-11-17), because a PIN can be watched or
 * handed over. A device with NO fingerprint (a car unit, a TV) cannot open Memory at all, and that is
 * wanted: a shared screen must not be able to search it (the owner, 2026-11-18). A PIN was written
 * for such devices the same day and is switched off, see [Pin].
 */
object Fingerprint {
    private const val KINDS = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK

    /** True when this device has a fingerprint (or face) enrolled and ready. */
    fun ready(context: Context): Boolean = runCatching {
        context.getSystemService(BiometricManager::class.java)?.canAuthenticate(KINDS) == BiometricManager.BIOMETRIC_SUCCESS
    }.getOrDefault(false)

    /** Shows the system sheet, or the PIN where there is no fingerprint. [onResult] gets true only for a real match. */
    fun ask(context: Context, title: String, subtitle: String, onResult: (Boolean) -> Unit) {
        if (!ready(context)) { if (Pin.allowed(context)) Pin.ask(context, title, onResult) else onResult(false); return }
        runCatching {
            val executor = context.mainExecutor
            BiometricPrompt.Builder(context)
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(KINDS)
                .setNegativeButton("Cancel", executor) { _, _ -> onResult(false) }
                .build()
                .authenticate(CancellationSignal(), executor, object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = onResult(true)
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) = onResult(false)
                    // onAuthenticationFailed = one bad read; the sheet stays up for another try.
                })
        }.onFailure { onResult(false) }
    }

    // The switch in Settings > Privacy. On unless he turned it off (which itself takes a fingerprint).
    private const val PREFS = "pan_ui"
    private const val KEY = "memory_lock"
    fun lockOn(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, true)
    fun setLock(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply()
    }
}
