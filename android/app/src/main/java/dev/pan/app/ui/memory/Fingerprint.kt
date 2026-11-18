package dev.pan.app.ui.memory

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal

/**
 * The lock on Memory. On a device with a fingerprint (or face, where that is its biometric) it is
 * always the fingerprint, never the device's PIN or pattern: the owner's rule (2026-11-17), because
 * a PIN can be watched or handed over. A device with NO fingerprint (a car unit, some tablets) could
 * not open Memory at all; since 0.5.11 it uses a PIN set in ΠAN itself, see [Pin] (the owner,
 * 2026-11-18).
 */
object Fingerprint {
    private const val KINDS = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK

    /** True when this device has a fingerprint (or face) enrolled and ready. */
    fun ready(context: Context): Boolean = runCatching {
        context.getSystemService(BiometricManager::class.java)?.canAuthenticate(KINDS) == BiometricManager.BIOMETRIC_SUCCESS
    }.getOrDefault(false)

    /** Shows the system sheet, or the PIN where there is no fingerprint. [onResult] gets true only for a real match. */
    fun ask(context: Context, title: String, subtitle: String, onResult: (Boolean) -> Unit) {
        if (!ready(context)) { Pin.ask(context, title, onResult); return }
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
