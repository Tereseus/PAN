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

    // Tier 0: current user + active org info
    @GET("/api/v1/auth/me")
    suspend fun getMe(): Response<MeResponse>

    // Tier 0 Phase 4: org policy (incognito/blackout allowed, retention days)
    @GET("/api/v1/org/policy")
    suspend fun getOrgPolicy(): Response<OrgPolicyResponse>

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

    @POST("/api/v1/terminal/send")
    suspend fun sendTerminalCommand(@Body request: TerminalSendRequest): Response<TerminalSendResponse>

    @GET("/dashboard/api/conversations")
    suspend fun searchConversations(
        @retrofit2.http.Query("q") query: String,
        @retrofit2.http.Query("limit") limit: Int = 10,
        @retrofit2.http.Query("filter") filter: String = "all"
    ): Response<ConversationSearchResponse>

    @POST("/api/v1/recall")
    suspend fun recall(@Body request: QueryRequest): Response<QueryResponse>

    @GET("/api/v1/terminal/wait-response")
    suspend fun waitTerminalResponse(
        @retrofit2.http.Query("since") since: String,
        @retrofit2.http.Query("timeout") timeout: Int = 30000
    ): Response<TerminalWaitResponse>

    @GET("/api/v1/terminal/permissions")
    suspend fun getPermissions(): Response<PermissionsResponse>

    @POST("/api/v1/terminal/permissions/respond")
    suspend fun respondPermission(@Body request: PermissionRespondRequest): Response<Unit>

    // Sensor management
    @GET("/api/sensors/devices/{deviceId}")
    suspend fun getDeviceSensors(@retrofit2.http.Path("deviceId") deviceId: Int): Response<DeviceSensorsResponse>

    @PUT("/api/sensors/devices/{deviceId}/{sensorId}")
    suspend fun updateSensor(
        @retrofit2.http.Path("deviceId") deviceId: Int,
        @retrofit2.http.Path("sensorId") sensorId: String,
        @Body request: SensorUpdateRequest
    ): Response<Unit>

    @PUT("/api/sensors/devices/{deviceId}/{sensorId}/attach/{attachTo}")
    suspend fun updateSensorAttachment(
        @retrofit2.http.Path("deviceId") deviceId: Int,
        @retrofit2.http.Path("sensorId") sensorId: String,
        @retrofit2.http.Path("attachTo") attachTo: String,
        @Body request: SensorAttachRequest
    ): Response<Unit>

    // Intuition — live situational awareness
    @GET("/api/v1/intuition/current")
    suspend fun getIntuitionCurrent(): Response<IntuitionResponse>

    @GET("/api/v1/settings")
    suspend fun getSettings(): Response<Map<String, Any>>

    @retrofit2.http.PUT("/api/v1/settings")
    suspend fun updateSettings(@Body body: Map<String, String>): Response<Map<String, Any>>

    // Wipe a non-main memory scope on the server (true incognito "forget").
    @POST("/api/v1/memory/scope/{scope}/wipe")
    suspend fun wipeScope(@retrofit2.http.Path("scope") scope: String): Response<Map<String, Any>>

    @POST("/api/v1/tailscale/auto-auth")
    suspend fun getTailscaleAuthKey(@Body request: Map<String, String>): Response<Map<String, Any>>

    // Telemetry — ship logs to server
    @POST("/api/v1/logs")
    suspend fun shipLogs(@Body logs: List<LogEntry>): Response<LogInsertResponse>

    // Device registration — links device to user/org
    @POST("/api/v1/devices/register")
    suspend fun registerDevice(@Body request: DeviceRegisterRequest): Response<Unit>

    // Conversation history persistence
    @POST("/api/v1/history")
    suspend fun appendHistory(@Body request: HistoryRequest): Response<Unit>

    @GET("/api/v1/history")
    suspend fun getHistory(
        @Query("device_id") deviceId: String,
        @Query("limit") limit: Int = 10
    ): Response<HistoryResponse>
}
