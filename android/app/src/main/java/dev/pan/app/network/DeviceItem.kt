package dev.pan.app.network

/** One device the hub knows, as `GET /api/v1/devices/list` gives it. */
data class DeviceItem(
    val id: Int = 0,
    val hostname: String,
    val name: String,
    val device_type: String,
    val last_seen: String
)
