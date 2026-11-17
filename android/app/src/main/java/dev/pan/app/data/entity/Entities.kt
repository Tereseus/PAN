package dev.pan.app.data.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "pending_uploads")
data class PendingUploadEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String, // "audio", "photo", "sensor"
    val payload: String, // JSON
    val createdAt: Long = System.currentTimeMillis(),
    val synced: Boolean = false
)

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val role: String, // "user" or "pan"
    val text: String,
    val timestamp: Long = System.currentTimeMillis(),
    /** A picture PAN took for this answer (a file on the phone), or null. Added in database version 2. */
    val photo: String? = null,
    /** How long his line waited for PAN's first word, ms. Added in database version 3. */
    val ms: Long? = null,
    /** Where the time went and who answered, as a small JSON object. Added in version 3. */
    val detail: String? = null
)

@Entity(tableName = "settings")
data class SettingEntity(
    @PrimaryKey val key: String,
    val value: String
)
