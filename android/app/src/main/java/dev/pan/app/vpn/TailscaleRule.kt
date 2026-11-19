package dev.pan.app.vpn

/**
 * When the app's own Tailscale is started. ΠAN Link is the way a device reaches its hub, and
 * people must never see Tailscale or be asked to sign in to it (the owner). The app used to
 * start it for everyone whenever Home opened: a second permanent notification, the word
 * "Tailscale" on screen, and a process talking to Tailscale's servers for someone who has none.
 *
 * It starts only where it can do something:
 *  - the hub has just handed this device a key (a hub whose owner set that up), or
 *  - this device has reached its hub over Tailscale before, or
 *  - someone turned it on by hand under Settings > Advanced.
 */
object TailscaleRule {
    fun starts(haveKey: Boolean, usedBefore: Boolean, byHand: Boolean): Boolean = haveKey || usedBefore || byHand
}
