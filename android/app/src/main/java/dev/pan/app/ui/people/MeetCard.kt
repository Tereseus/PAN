package dev.pan.app.ui.people

import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec

/**
 * The code two people show each other to meet (docs/PEOPLE-PLAN.md, Decided 4: a stranger is
 * added only by a deliberate act of both people).
 *
 * A code is a `pan://meet` link shown as a QR: a name, this device's public key, the time, and a
 * signature over those made with the key. The other person's ΠAN scans it, checks the signature
 * and that the code is a few minutes old at most, asks its wearer, and then tells its OWN hub
 * "I met this person". Nothing is sent between the two ΠANs: the only thing that crosses is the
 * picture on the screen. For both to have each other, each scans the other's code.
 *
 * The key is made once in the phone's keystore and never leaves it. It is how the same person
 * is known next time, and what a later talk between the two devices will be checked against.
 * A photo of a code is useless after a few minutes, and can only ever add the person it shows
 * to the list of whoever scans it.
 */
object MeetCard {
    private const val TAG = "MeetCard"
    private const val ALIAS = "pan_meet_v1"
    private const val FRESH_MS = 3 * 60_000L
    const val PREFIX = "pan://meet?"

    data class Card(val name: String, val key: String)

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun unb64(text: String) = Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun signed(name: String, key: String, at: Long) = "pan-meet-1|$name|$key|$at".toByteArray(Charsets.UTF_8)

    private fun keys(): Pair<PrivateKey, ByteArray> {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build())
            }.generateKeyPair()
        }
        return (store.getKey(ALIAS, null) as PrivateKey) to store.getCertificate(ALIAS).publicKey.encoded
    }

    /** This device's code for [name], good for a few minutes. null if the phone could not make one. */
    fun mine(name: String, now: Long = System.currentTimeMillis()): String? = try {
        val shown = name.trim().replace(Regex("\\s+"), " ").take(60)
        val (private, public) = keys()
        val key = b64(public)
        val at = now / 1000
        val sig = Signature.getInstance("SHA256withECDSA").run { initSign(private); update(signed(shown, key, at)); sign() }
        Uri.Builder().scheme("pan").authority("meet")
            .appendQueryParameter("n", shown).appendQueryParameter("k", key)
            .appendQueryParameter("t", at.toString()).appendQueryParameter("s", b64(sig)).build().toString()
    } catch (e: Exception) {
        Log.w(TAG, "could not make a code: ${e.message}")
        null
    }

    /**
     * What a scanned code says, or null when it is not a real one: not a `pan://meet` link, a bad
     * signature, older than a few minutes (or from the future), or this device's own code.
     */
    fun read(text: String, now: Long = System.currentTimeMillis()): Card? = try {
        val uri = Uri.parse(text)
        val name = uri.getQueryParameter("n")?.trim().orEmpty()
        val key = uri.getQueryParameter("k").orEmpty()
        val at = uri.getQueryParameter("t")?.toLongOrNull() ?: 0L
        val sig = uri.getQueryParameter("s").orEmpty()
        when {
            uri.scheme != "pan" || uri.host != "meet" -> null
            name.isBlank() || name.length > 60 || !Regex("^[A-Za-z0-9_-]{40,400}$").matches(key) -> null
            kotlin.math.abs(now - at * 1000) > FRESH_MS -> null
            key == b64(keys().second) -> null
            else -> {
                val public = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(unb64(key)))
                val good = Signature.getInstance("SHA256withECDSA").run { initVerify(public); update(signed(name, key, at)); verify(unb64(sig)) }
                if (good) Card(name, key) else null
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "not a code: ${e.message}")
        null
    }
}
