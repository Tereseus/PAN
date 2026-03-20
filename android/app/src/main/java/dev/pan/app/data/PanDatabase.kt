package dev.pan.app.data

import androidx.room.Database
import androidx.room.RoomDatabase
import dev.pan.app.data.dao.*
import dev.pan.app.data.entity.*

@Database(
    entities = [PendingUploadEntity::class, ConversationEntity::class, SettingEntity::class],
    version = 1,
    exportSchema = false
)
abstract class PanDatabase : RoomDatabase() {
    abstract fun pendingUploadDao(): PendingUploadDao
    abstract fun conversationDao(): ConversationDao
    abstract fun settingsDao(): SettingsDao
}
