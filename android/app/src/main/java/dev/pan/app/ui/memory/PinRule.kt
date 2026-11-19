package dev.pan.app.ui.memory

/**
 * Which device may open Memory with a PIN of its own when it has no fingerprint (see [Pin]).
 * A phone: yes, it is one person's. Anything else (a car unit, a TV, a tablet): only when granted.
 */
object PinRule {
    fun allowed(granted: Boolean, isPhone: Boolean): Boolean = granted || isPhone
}
