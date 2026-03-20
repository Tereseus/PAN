package dev.pan.app.data

import com.google.gson.Gson
import dev.pan.app.data.dao.*
import dev.pan.app.data.entity.*
import dev.pan.app.network.dto.*
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class DataRepository @Inject constructor(
    private val pendingUploadDao: PendingUploadDao,
    private val conversationDao: ConversationDao,
    private val settingsDao: SettingsDao
) {
    private val gson = Gson()

    // Pending uploads
    suspend fun queueAudioUpload(upload: AudioUpload) {
        pendingUploadDao.insert(PendingUploadEntity(
            type = "audio",
            payload = gson.toJson(upload)
        ))
    }

    suspend fun queuePhotoUpload(upload: PhotoUpload) {
        pendingUploadDao.insert(PendingUploadEntity(
            type = "photo",
            payload = gson.toJson(upload)
        ))
    }

    suspend fun queueSensorUpload(upload: SensorUpload) {
        pendingUploadDao.insert(PendingUploadEntity(
            type = "sensor",
            payload = gson.toJson(upload)
        ))
    }

    suspend fun getPendingUploads(): List<PendingUploadEntity> = pendingUploadDao.getPending()
    suspend fun markSynced(id: Long) = pendingUploadDao.markSynced(id)
    fun pendingCount() = pendingUploadDao.pendingCount()

    // Audio segments from mic capture
    suspend fun saveAudioSegment(samples: ShortArray) {
        // For now, queue a placeholder. STT will process this into a transcript.
        val upload = AudioUpload(
            transcript = "[raw_audio:${samples.size}_samples]",
            timestamp = System.currentTimeMillis(),
            duration_ms = (samples.size * 1000L) / 16000
        )
        queueAudioUpload(upload)
    }

    // Conversations
    suspend fun addUserMessage(text: String) {
        conversationDao.insert(ConversationEntity(role = "user", text = text))
    }

    suspend fun addPanResponse(text: String) {
        conversationDao.insert(ConversationEntity(role = "pan", text = text))
    }

    fun getRecentConversations() = conversationDao.getRecent()

    // Settings
    suspend fun setSetting(key: String, value: String) = settingsDao.set(SettingEntity(key, value))
    suspend fun getSetting(key: String): String? = settingsDao.get(key)
    fun getAllSettings() = settingsDao.getAll()

    // Deserializers for sync
    fun deserializeAudioUpload(json: String): AudioUpload? =
        try { gson.fromJson(json, AudioUpload::class.java) } catch (e: Exception) { null }

    fun deserializePhotoUpload(json: String): PhotoUpload? =
        try { gson.fromJson(json, PhotoUpload::class.java) } catch (e: Exception) { null }

    fun deserializeSensorUpload(json: String): SensorUpload? =
        try { gson.fromJson(json, SensorUpload::class.java) } catch (e: Exception) { null }
}
