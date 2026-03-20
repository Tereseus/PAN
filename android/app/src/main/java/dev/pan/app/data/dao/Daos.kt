package dev.pan.app.data.dao

import androidx.room.*
import dev.pan.app.data.entity.*
import kotlinx.coroutines.flow.Flow

@Dao
interface PendingUploadDao {
    @Insert
    suspend fun insert(upload: PendingUploadEntity)

    @Query("SELECT * FROM pending_uploads WHERE synced = 0 ORDER BY createdAt ASC LIMIT 50")
    suspend fun getPending(): List<PendingUploadEntity>

    @Query("UPDATE pending_uploads SET synced = 1 WHERE id = :id")
    suspend fun markSynced(id: Long)

    @Query("DELETE FROM pending_uploads WHERE synced = 1 AND createdAt < :before")
    suspend fun cleanOld(before: Long)

    @Query("SELECT COUNT(*) FROM pending_uploads WHERE synced = 0")
    fun pendingCount(): Flow<Int>
}

@Dao
interface ConversationDao {
    @Insert
    suspend fun insert(message: ConversationEntity)

    @Query("SELECT * FROM conversations ORDER BY timestamp DESC LIMIT 100")
    fun getRecent(): Flow<List<ConversationEntity>>

    @Query("DELETE FROM conversations WHERE timestamp < :before")
    suspend fun cleanOld(before: Long)
}

@Dao
interface SettingsDao {
    @Upsert
    suspend fun set(setting: SettingEntity)

    @Query("SELECT value FROM settings WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Query("SELECT * FROM settings")
    fun getAll(): Flow<List<SettingEntity>>
}
