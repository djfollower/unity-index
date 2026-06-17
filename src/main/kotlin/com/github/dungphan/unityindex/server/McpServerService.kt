package com.github.dungphan.unityindex.server

import com.github.dungphan.unityindex.McpBundle
import com.github.dungphan.unityindex.McpConstants
import com.github.dungphan.unityindex.server.transport.KtorMcpServer
import com.github.dungphan.unityindex.server.transport.KtorSseSessionManager
import com.github.dungphan.unityindex.settings.McpSettings
import com.github.dungphan.unityindex.settings.McpSettingsConfigurable
import com.github.dungphan.unityindex.tools.ToolRegistry
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.util.Alarm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Service(Service.Level.APP)
class McpServerService(
    private val coroutineScope: CoroutineScope
) : Disposable {

    private val toolRegistry: ToolRegistry = ToolRegistry()
    private val jsonRpcHandler: JsonRpcHandler
    private val sseSessionManager: KtorSseSessionManager = KtorSseSessionManager()
    private var ktorServer: KtorMcpServer? = null
    private var serverError: ServerError? = null

    @Volatile private var isShuttingDown = false
    @Volatile private var restartAttempts = 0
    private val watchdogAlarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    companion object {
        private val LOG = logger<McpServerService>()
        private const val WATCHDOG_INTERVAL_MS = 30_000
        private val RESTART_BACKOFF_MS = listOf(5_000, 15_000, 30_000)

        fun getInstance(): McpServerService = service()
    }

    data class ServerError(
        val message: String,
        val port: Int? = null
    )

    @Volatile
    var isInitialized: Boolean = false
        private set

    init {
        LOG.info("Initializing MCP Server Service (Protocol: ${McpConstants.MCP_PROTOCOL_VERSION})")
        jsonRpcHandler = JsonRpcHandler(toolRegistry)
        coroutineScope.launch { initialize() }
    }

    @Synchronized
    fun initialize() {
        if (isInitialized) return

        LOG.info("Performing deferred MCP Server initialization")

        toolRegistry.registerBuiltInTools()

        val settings = McpSettings.getInstance()
        val port = settings.serverPort
        val host = settings.serverHost
        isInitialized = true
        startServer(host, port)

        LOG.info("MCP Server Service initialized with Ktor CIO server")
    }

    fun startServer(host: String, port: Int): KtorMcpServer.StartResult {
        watchdogAlarm.cancelAllRequests()
        stopServer()

        LOG.info("Starting MCP Server on $host:$port")

        val server = KtorMcpServer(
            port = port,
            host = host,
            jsonRpcHandler = jsonRpcHandler,
            sseSessionManager = sseSessionManager,
            coroutineScope = coroutineScope,
            onUnexpectedStop = { scheduleRestart() }
        )

        val result = when (val startResult = server.start()) {
            is KtorMcpServer.StartResult.Success -> {
                ktorServer = server
                serverError = null
                LOG.info("MCP Server started successfully on $host:$port")
                scheduleWatchdog()
                startResult
            }
            is KtorMcpServer.StartResult.PortInUse -> {
                serverError = ServerError("Port $port is already in use", port)
                showErrorNotification(
                    McpBundle.message("notification.serverPortInUse.title"),
                    McpBundle.message("notification.serverPortInUse.content", port, host)
                )
                startResult
            }
            is KtorMcpServer.StartResult.Error -> {
                serverError = ServerError(startResult.message)
                LOG.warn("Failed to start MCP Server: ${startResult.message}", startResult.cause)
                showErrorNotification(
                    McpBundle.message("notification.serverStartFailed.title"),
                    McpBundle.message("notification.serverStartFailed.content", startResult.message)
                )
                startResult
            }
        }

        return result
    }

    fun stopServer() {
        ktorServer?.stop()
        ktorServer = null
    }

    fun restartServer(newHost: String, newPort: Int): KtorMcpServer.StartResult {
        LOG.info("Restarting MCP Server on $newHost:$newPort")
        return startServer(newHost, newPort)
    }

    fun isServerRunning(): Boolean = ktorServer?.isRunning() == true

    fun getServerError(): ServerError? = serverError

    fun getToolRegistry(): ToolRegistry = toolRegistry

    fun getJsonRpcHandler(): JsonRpcHandler = jsonRpcHandler

    fun getSseSessionManager(): KtorSseSessionManager = sseSessionManager

    fun getServerUrl(): String? {
        if (ktorServer == null || serverError != null) return null
        val settings = McpSettings.getInstance()
        val port = settings.serverPort
        val host = settings.serverHost
        return "http://$host:$port${McpConstants.STREAMABLE_HTTP_ENDPOINT_PATH}"
    }

    fun getLegacySseUrl(): String? {
        if (ktorServer == null || serverError != null) return null
        val settings = McpSettings.getInstance()
        val port = settings.serverPort
        val host = settings.serverHost
        return "http://$host:$port${McpConstants.SSE_ENDPOINT_PATH}"
    }

    fun getServerPort(): Int = McpSettings.getInstance().serverPort

    fun getServerInfo(): ServerStatusInfo {
        val settings = McpSettings.getInstance()
        val port = settings.serverPort
        val host = settings.serverHost
        val isRunning = isServerRunning()
        return ServerStatusInfo(
            name = McpConstants.SERVER_NAME,
            version = McpConstants.SERVER_VERSION,
            protocolVersion = McpConstants.MCP_PROTOCOL_VERSION,
            streamableHttpUrl = if (isRunning) "http://$host:$port${McpConstants.STREAMABLE_HTTP_ENDPOINT_PATH}" else "Server not running",
            legacySseUrl = if (isRunning) "http://$host:$port${McpConstants.SSE_ENDPOINT_PATH}" else "Server not running",
            postUrl = "http://$host:$port${McpConstants.MCP_ENDPOINT_PATH}",
            port = port,
            registeredTools = toolRegistry.getAllTools().size,
            error = serverError?.message,
            isRunning = isRunning
        )
    }

    private fun showErrorNotification(title: String, content: String) {
        ApplicationManager.getApplication().invokeLater({
            NotificationGroupManager.getInstance()
                .getNotificationGroup(McpConstants.NOTIFICATION_GROUP_ID)
                .createNotification(
                    title,
                    content,
                    NotificationType.ERROR
                )
                .addAction(object : NotificationAction(McpBundle.message("notification.action.openSettings")) {
                    override fun actionPerformed(e: AnActionEvent, notification: Notification) {
                        ShowSettingsUtil.getInstance().showSettingsDialog(null, McpSettingsConfigurable::class.java)
                        notification.expire()
                    }
                })
                .notify(null)
        }, ModalityState.any())
    }

    private fun scheduleRestart() {
        if (isShuttingDown) return
        val delayMs = RESTART_BACKOFF_MS.getOrElse(restartAttempts) { RESTART_BACKOFF_MS.last() }.toLong()
        restartAttempts++
        LOG.warn("Scheduling MCP Server restart in ${delayMs}ms (attempt $restartAttempts)")
        watchdogAlarm.addRequest({
            if (!isShuttingDown) {
                val settings = McpSettings.getInstance()
                val result = startServer(settings.serverHost, settings.serverPort)
                if (result is KtorMcpServer.StartResult.Success) {
                    restartAttempts = 0
                    LOG.info("watchdog: MCP Server restarted successfully")
                    scheduleWatchdog()
                } else {
                    LOG.warn("watchdog: MCP Server restart failed ($result) — will retry")
                    scheduleRestart()
                }
            }
        }, delayMs)
    }

    private fun scheduleWatchdog() {
        if (isShuttingDown) return
        watchdogAlarm.addRequest({
            if (!isShuttingDown && isInitialized) {
                if (!isServerRunning()) {
                    LOG.warn("watchdog: MCP Server not running — triggering restart")
                    scheduleRestart()
                } else {
                    scheduleWatchdog()
                }
            }
        }, WATCHDOG_INTERVAL_MS.toLong())
    }

    override fun dispose() {
        LOG.info("Disposing MCP Server Service")
        isShuttingDown = true
        watchdogAlarm.cancelAllRequests()
        stopServer()
        sseSessionManager.closeAllSessions()
    }
}

data class ServerStatusInfo(
    val name: String,
    val version: String,
    val protocolVersion: String,
    val streamableHttpUrl: String,
    val legacySseUrl: String,
    val postUrl: String,
    val port: Int,
    val registeredTools: Int,
    val error: String? = null,
    val isRunning: Boolean = true
)
