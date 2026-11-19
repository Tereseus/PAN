package dev.pan.app.update

/**
 * When the app fetches a new build without being asked. The build is 219 MB since ΠAN's voice is
 * inside it (0.5.38), and the check at launch used to fetch it on any network, at any moment: on
 * 2026-11-19 it came down in the middle of a call. The Settings button fetches it whenever asked.
 */
object UpdatePolicy {
    /** At launch: only on a network that is not metered (home Wi-Fi), and never during a call. */
    fun fetchAtLaunch(metered: Boolean, inCall: Boolean): Boolean = !metered && !inCall
}
