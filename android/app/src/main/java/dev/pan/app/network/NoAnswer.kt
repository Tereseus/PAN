package dev.pan.app.network

/**
 * What ΠAN says when a line got no answer from the hub. It said "Server didn't respond." for
 * everything: a phone that was never paired, a phone with no internet, and a computer that is
 * off. Each has its own sentence, in the order a person can do something about it.
 */
object NoAnswer {
    fun words(paired: Boolean, online: Boolean): String = when {
        !paired -> "This phone isn't paired with a computer yet."
        !online -> "There's no internet on this phone."
        else -> "Your computer isn't answering."
    }
}
