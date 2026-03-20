package dev.pan.app.network

import dev.pan.app.network.dto.*
import retrofit2.Response
import retrofit2.http.*

interface PanServerApi {
    @POST("/api/v1/audio")
    suspend fun uploadAudio(@Body audio: AudioUpload): Response<Unit>

    @POST("/api/v1/photo")
    suspend fun uploadPhoto(@Body photo: PhotoUpload): Response<Unit>

    @POST("/api/v1/sensor")
    suspend fun uploadSensor(@Body sensor: SensorUpload): Response<Unit>

    @POST("/api/v1/query")
    suspend fun query(@Body request: QueryRequest): Response<QueryResponse>

    @GET("/health")
    suspend fun health(): Response<ServerStatus>

    @POST("/api/v1/sync")
    suspend fun syncBatch(@Body batch: SyncBatch): Response<Unit>

    @GET("/api/v1/devices/commands/history")
    suspend fun commandHistory(): Response<List<dev.pan.app.ui.commands.CommandItem>>

    @GET("/api/v1/devices/list")
    suspend fun deviceList(): Response<List<dev.pan.app.ui.commands.DeviceItem>>

    @GET("/api/v1/devices/commands/{id}/logs")
    suspend fun commandLogs(@retrofit2.http.Path("id") commandId: Long): Response<List<dev.pan.app.ui.commands.LogItem>>

    @POST("/api/v1/vision")
    suspend fun vision(@Body request: VisionRequest): Response<VisionResponse>
}
