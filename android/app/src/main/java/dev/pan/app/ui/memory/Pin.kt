package dev.pan.app.ui.memory

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.ContextWrapper
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.util.Base64
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * The lock on Memory for a device that has no fingerprint (a car unit, some tablets): a PIN set in
 * ΠAN itself. A device with a fingerprint never gets here, the fingerprint stays the only way in
 * there (the owner, 2026-11-18: "if no fingerprint, then make it be a PIN").
 *
 * The PIN is 4 to 8 digits. Only a salted, slow hash of it is kept (PBKDF2), so the app's own files
 * do not give it away. Five wrong tries in a row and the lock rests, longer each time. There is no
 * way to read a forgotten PIN back: clearing ΠAN's data in the device's settings starts over.
 * The first person to open Memory on such a device is the one who sets the PIN, so set it at once.
 */
object Pin {
    private const val PREFS = "pan_ui"
    private const val KEY_HASH = "memory_pin_hash"
    private const val KEY_SALT = "memory_pin_salt"
    private const val KEY_FAILS = "memory_pin_fails"
    private const val KEY_WAIT = "memory_pin_wait_until"
    private const val ROUNDS = 60_000
    private const val MIN = 4
    private const val MAX = 8

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isSet(context: Context): Boolean = prefs(context).getString(KEY_HASH, null) != null

    /** Asks for the PIN, or has it set when there is none yet. [onResult] gets true only for the right PIN. */
    fun ask(context: Context, title: String, onResult: (Boolean) -> Unit) {
        val activity = activityOf(context) ?: run { onResult(false); return }
        if (isSet(activity)) enter(activity, title, onResult) else choose(activity, onResult)
    }

    /** The old PIN first, then a new one. */
    fun change(context: Context, onDone: (Boolean) -> Unit) {
        val activity = activityOf(context) ?: run { onDone(false); return }
        if (!isSet(activity)) { choose(activity, onDone); return }
        enter(activity, "Your PIN now") { ok -> if (ok) choose(activity, onDone) else onDone(false) }
    }

    private fun activityOf(context: Context): Activity? {
        var c: Context? = context
        while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
        return null
    }

    private fun hash(pin: String, salt: ByteArray): String {
        val spec = PBEKeySpec(pin.toCharArray(), salt, ROUNDS, 256)
        return try {
            Base64.encodeToString(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, Base64.NO_WRAP)
        } finally { spec.clearPassword() }
    }

    private fun field(activity: Activity, hint: String) = EditText(activity).apply {
        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        filters = arrayOf(InputFilter.LengthFilter(MAX))
        this.hint = hint
    }

    private fun box(activity: Activity, vararg views: android.view.View) = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        setPadding(pad, pad / 2, pad, 0)
        views.forEach { addView(it) }
    }

    /** Slow on purpose, so off the main thread; the answer comes back on it. */
    private fun slow(work: () -> Boolean, then: (Boolean) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        Thread { val r = runCatching(work).getOrDefault(false); main.post { then(r) } }.start()
    }

    private fun choose(activity: Activity, onResult: (Boolean) -> Unit) {
        val first = field(activity, "New PIN, $MIN to $MAX digits")
        val again = field(activity, "The same PIN again")
        val note = TextView(activity).apply { text = "This device has no fingerprint, so a PIN opens Memory here. It cannot be read back if you forget it." }
        var done = false
        val dialog = AlertDialog.Builder(activity)
            .setTitle("Set a PIN for Memory")
            .setView(box(activity, note, first, again))
            .setPositiveButton("Set", null)
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!done) onResult(false) }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { button ->
                val a = first.text.toString(); val b = again.text.toString()
                when {
                    a.length < MIN -> first.error = "At least $MIN digits"
                    a != b -> again.error = "Not the same"
                    else -> {
                        button.isEnabled = false
                        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
                        slow({
                            prefs(activity).edit()
                                .putString(KEY_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
                                .putString(KEY_HASH, hash(a, salt))
                                .putInt(KEY_FAILS, 0).putLong(KEY_WAIT, 0L).commit()
                        }) { ok -> done = ok; dialog.dismiss(); if (ok) onResult(true) }
                    }
                }
            }
        }
        dialog.show()
    }

    private fun enter(activity: Activity, title: String, onResult: (Boolean) -> Unit) {
        val p = prefs(activity)
        val wait = p.getLong(KEY_WAIT, 0L) - System.currentTimeMillis()
        if (wait > 0) {
            AlertDialog.Builder(activity).setTitle("Too many wrong tries")
                .setMessage("Try again in ${(wait / 1000 + 1)} seconds.")
                .setPositiveButton("OK", null).setOnDismissListener { onResult(false) }.show()
            return
        }
        val input = field(activity, "PIN")
        var done = false
        val dialog = AlertDialog.Builder(activity)
            .setTitle(title)
            .setView(box(activity, input))
            .setPositiveButton("Open", null)
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!done) onResult(false) }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { button ->
                val typed = input.text.toString()
                if (typed.length < MIN) { input.error = "At least $MIN digits"; return@setOnClickListener }
                button.isEnabled = false
                slow({
                    val salt = Base64.decode(p.getString(KEY_SALT, ""), Base64.NO_WRAP)
                    java.security.MessageDigest.isEqual(hash(typed, salt).toByteArray(), (p.getString(KEY_HASH, "") ?: "").toByteArray())
                }) { right ->
                    if (right) {
                        p.edit().putInt(KEY_FAILS, 0).putLong(KEY_WAIT, 0L).apply()
                        done = true; dialog.dismiss(); onResult(true)
                    } else {
                        val fails = p.getInt(KEY_FAILS, 0) + 1
                        // Five wrong in a row: 30 seconds, then a minute, two, four ... up to an hour.
                        val rest = if (fails >= 5) minOf(3_600_000L, 30_000L shl minOf(fails - 5, 7)) else 0L
                        p.edit().putInt(KEY_FAILS, fails).putLong(KEY_WAIT, if (rest > 0) System.currentTimeMillis() + rest else 0L).apply()
                        if (rest > 0) dialog.dismiss() else {
                            input.setText(""); input.error = "Wrong PIN"; button.isEnabled = true
                        }
                    }
                }
            }
        }
        dialog.show()
    }
}
