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
    suspend fun insert(message: ConversationEntity): Long

    // Something learned about a line after it was stored (how it is read aloud, word by word).
    @Query("UPDATE conversations SET detail = :detail WHERE id = :id")
    suspend fun setDetail(id: Long, detail: String)

    @Query("SELECT * FROM conversations ORDER BY timestamp DESC LIMIT 100")
    fun getRecent(): Flow<List<ConversationEntity>>

    @Query("DELETE FROM conversations WHERE timestamp < :before")
    suspend fun cleanOld(before: Long)

    // The hub heard the line better than the phone did: the newest line with the rough words gets the good ones.
    @Query("UPDATE conversations SET text = :better WHERE id = (SELECT id FROM conversations WHERE role = 'user' AND text = :rough ORDER BY id DESC LIMIT 1)")
    suspend fun correctUserLine(rough: String, better: String)

    @Query("DELETE FROM conversations WHERE id = (SELECT id FROM conversations WHERE role = 'user' AND text = :text ORDER BY id DESC LIMIT 1)")
    suspend fun dropUserLine(text: String)

    // The "Not for PAN" note that belongs to that line, if it has one (the row right after it).
    @Query("DELETE FROM conversations WHERE role = 'note' AND id = (SELECT MIN(id) FROM conversations WHERE id > (SELECT id FROM conversations WHERE role = 'user' AND text = :text ORDER BY id DESC LIMIT 1))")
    suspend fun dropNoteAfterUserLine(text: String)

    // Forgetting in Memory also takes the phone's own copy of the talk.
    @Query("DELETE FROM conversations WHERE text LIKE '%' || :word || '%'")
    suspend fun deleteContaining(word: String)

    @Query("DELETE FROM conversations WHERE timestamp >= :from AND timestamp < :to")
    suspend fun deleteBetween(from: Long, to: Long)
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
