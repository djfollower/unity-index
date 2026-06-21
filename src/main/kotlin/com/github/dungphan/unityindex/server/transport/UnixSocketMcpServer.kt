package com.github.dungphan.unityindex.server.transport

import com.github.dungphan.unityindex.McpConstants
import com.github.dungphan.unityindex.server.JsonRpcHandler
import com.github.dungphan.unityindex.server.models.JsonRpcError
import com.github.dungphan.unityindex.server.models.JsonRpcResponse
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.asContextElement
import com.intellij.openapi.diagnostic.logger
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.AsynchronousCloseException
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.nio.file.Files
import java.nio.file.Path

/**
 * MCP server listening on a Unix domain socket.
 *
 * Speaks a minimal subset of HTTP/1.1 (POST only) over UDS, just enough for
 * MCP Streamable HTTP clients that support unix socket connections.
 * This bypasses TCP entirely, so corporate firewall / localhost restrictions don't apply.
 */
class UnixSocketMcpServer(
    private val socketPath: Path,
    private val jsonRpcHandler: JsonRpcHandler,
    private val coroutineScope: CoroutineScope,
    private val onUnexpectedStop: (() -> Unit)? = null
) : Disposable {

    private var serverChannel: ServerSocketChannel? = null
    private var acceptJob: Job? = null
    @Volatile private var intentionallyStopped = false
    @Volatile private var running = false

    companion object {
        private val LOG = logger<UnixSocketMcpServer>()
        private const val MAX_REQUEST_SIZE = 16 * 1024 * 1024 // 16 MB
    }

    sealed class StartResult {
        data object Success : StartResult()
        data class Error(val message: String, val cause: Throwable? = null) : StartResult()
    }

    fun start(): StartResult {
        intentionallyStopped = false
        return try {
            Files.deleteIfExists(socketPath)

            val parent = socketPath.parent
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent)
            }

            val channel = ServerSocketChannel.open(StandardProtocolFamily.UNIX)
            channel.bind(UnixDomainSocketAddress.of(socketPath))
            serverChannel = channel
            running = true

            acceptJob = coroutineScope.launch(Dispatchers.IO) {
                try {
                    acceptLoop(channel)
                } catch (_: AsynchronousCloseException) {
                    // Expected on shutdown
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    LOG.error("Unix socket accept loop failed", e)
                    if (!intentionallyStopped) {
                        running = false
                        onUnexpectedStop?.invoke()
                    }
                }
            }

            LOG.info("Unix socket MCP server started on $socketPath")
            StartResult.Success
        } catch (e: Exception) {
            LOG.error("Failed to start Unix socket MCP server on $socketPath", e)
            StartResult.Error(e.message ?: "Unknown error", e)
        }
    }

    fun stop() {
        intentionallyStopped = true
        running = false
        acceptJob?.cancel()
        acceptJob = null
        try {
            serverChannel?.close()
        } catch (e: Exception) {
            LOG.warn("Error closing Unix socket server channel", e)
        }
        serverChannel = null
        try {
            Files.deleteIfExists(socketPath)
        } catch (e: Exception) {
            LOG.warn("Failed to delete socket file: $socketPath", e)
        }
        LOG.info("Unix socket MCP server stopped")
    }

    fun isRunning(): Boolean = running && serverChannel?.isOpen == true

    fun getSocketPath(): Path = socketPath

    override fun dispose() = stop()

    private suspend fun acceptLoop(server: ServerSocketChannel) {
        while (server.isOpen && !intentionallyStopped) {
            val client = try {
                withContext(Dispatchers.IO) { server.accept() }
            } catch (_: AsynchronousCloseException) {
                break
            } catch (e: Exception) {
                if (!intentionallyStopped) LOG.warn("Error accepting Unix socket connection", e)
                continue
            }

            coroutineScope.launch(Dispatchers.IO) {
                handleConnection(client)
            }
        }
    }

    private suspend fun handleConnection(client: SocketChannel) {
        client.use { channel ->
            try {
                while (channel.isOpen) {
                    val request = readHttpRequest(channel) ?: break
                    val response = processRequest(request)
                    writeHttpResponse(channel, response)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LOG.debug("Unix socket connection error: ${e.message}")
            }
        }
    }

    private data class HttpRequest(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String
    )

    private data class HttpResponse(
        val statusCode: Int,
        val statusText: String,
        val contentType: String,
        val body: String
    )

    private fun readHttpRequest(channel: SocketChannel): HttpRequest? {
        val headerBuf = ByteBuffer.allocate(8192)
        val accumulated = StringBuilder()

        while (!accumulated.contains("\r\n\r\n")) {
            headerBuf.clear()
            val bytesRead = channel.read(headerBuf)
            if (bytesRead == -1) return null
            headerBuf.flip()
            val bytes = ByteArray(headerBuf.remaining())
            headerBuf.get(bytes)
            accumulated.append(String(bytes, Charsets.UTF_8))

            if (accumulated.length > 65536) return null
        }

        val headerEnd = accumulated.indexOf("\r\n\r\n")
        val headerSection = accumulated.substring(0, headerEnd)
        val afterHeaders = accumulated.substring(headerEnd + 4)

        val lines = headerSection.split("\r\n")
        if (lines.isEmpty()) return null

        val requestLine = lines[0].split(" ", limit = 3)
        if (requestLine.size < 2) return null

        val method = requestLine[0]
        val path = requestLine[1]

        val headers = mutableMapOf<String, String>()
        for (i in 1 until lines.size) {
            val colonIdx = lines[i].indexOf(':')
            if (colonIdx > 0) {
                val key = lines[i].substring(0, colonIdx).trim().lowercase()
                val value = lines[i].substring(colonIdx + 1).trim()
                headers[key] = value
            }
        }

        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        if (contentLength > MAX_REQUEST_SIZE) return null

        val bodyBuilder = StringBuilder(afterHeaders)
        while (bodyBuilder.length < contentLength) {
            val buf = ByteBuffer.allocate(minOf(8192, contentLength - bodyBuilder.length))
            val n = channel.read(buf)
            if (n == -1) return null
            buf.flip()
            val bytes = ByteArray(buf.remaining())
            buf.get(bytes)
            bodyBuilder.append(String(bytes, Charsets.UTF_8))
        }

        return HttpRequest(
            method = method,
            path = path,
            headers = headers,
            body = bodyBuilder.substring(0, contentLength)
        )
    }

    private suspend fun processRequest(request: HttpRequest): HttpResponse {
        if (request.method == "OPTIONS") {
            return HttpResponse(204, "No Content", "text/plain", "")
        }

        if (request.method != "POST") {
            return HttpResponse(405, "Method Not Allowed", "text/plain", "Only POST is supported")
        }

        val validPaths = setOf(
            McpConstants.STREAMABLE_HTTP_ENDPOINT_PATH,
            McpConstants.MCP_ENDPOINT_PATH,
            McpConstants.SSE_ENDPOINT_PATH
        )
        val requestPath = request.path.split("?")[0]
        if (requestPath !in validPaths) {
            return HttpResponse(
                404, "Not Found", "application/json",
                createJsonRpcError(null, -32600, "Unknown endpoint: $requestPath")
            )
        }

        if (request.body.isBlank()) {
            return HttpResponse(
                400, "Bad Request", "application/json",
                createJsonRpcError(null, -32700, "Empty request body")
            )
        }

        val element = try {
            json.parseToJsonElement(request.body)
        } catch (e: Exception) {
            return HttpResponse(
                400, "Bad Request", "application/json",
                createJsonRpcError(null, -32700, "Parse error: ${e.message}")
            )
        }

        if (element is JsonArray) {
            return handleBatchRequest(element)
        }

        val parsed = element as? JsonObject ?: return HttpResponse(
            400, "Bad Request", "application/json",
            createJsonRpcError(null, -32600, "Invalid JSON-RPC message")
        )

        val hasId = parsed.containsKey("id") && parsed["id"] != JsonNull
        val method = parsed["method"]?.jsonPrimitive?.contentOrNull
        val isResponse = !parsed.containsKey("method") && (parsed.containsKey("result") || parsed.containsKey("error"))

        if (isResponse) {
            return HttpResponse(202, "Accepted", "text/plain", "")
        }

        if (method == null && !hasId) {
            return HttpResponse(
                400, "Bad Request", "application/json",
                createJsonRpcError(null, -32600, "Invalid JSON-RPC message")
            )
        }

        if (!hasId) {
            try {
                runWithIdeModality {
                    jsonRpcHandler.handleRequest(
                        request.body,
                        protocolVersion = McpConstants.STREAMABLE_HTTP_MCP_PROTOCOL_VERSION
                    )
                }
            } catch (e: Exception) {
                LOG.debug("Error processing notification via Unix socket: ${e.message}")
            }
            return HttpResponse(202, "Accepted", "text/plain", "")
        }

        return try {
            val result = runWithIdeModality {
                jsonRpcHandler.handleRequest(
                    request.body,
                    protocolVersion = McpConstants.STREAMABLE_HTTP_MCP_PROTOCOL_VERSION
                )
            }
            if (result != null) {
                HttpResponse(200, "OK", "application/json", result)
            } else {
                HttpResponse(202, "Accepted", "text/plain", "")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LOG.error("Error processing MCP request via Unix socket", e)
            HttpResponse(
                500, "Internal Server Error", "application/json",
                createJsonRpcError(parsed["id"], -32603, e.message ?: "Internal error")
            )
        }
    }

    private suspend fun handleBatchRequest(batch: JsonArray): HttpResponse {
        if (batch.isEmpty()) {
            return HttpResponse(
                400, "Bad Request", "application/json",
                createJsonRpcError(null, -32600, "JSON-RPC batch requests must not be empty")
            )
        }

        val responses = mutableListOf<JsonElement>()
        for (message in batch) {
            val parsed = message as? JsonObject ?: continue
            val hasId = parsed.containsKey("id") && parsed["id"] != JsonNull

            val response = try {
                runWithIdeModality {
                    jsonRpcHandler.handleRequest(
                        message.toString(),
                        protocolVersion = McpConstants.STREAMABLE_HTTP_MCP_PROTOCOL_VERSION
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LOG.error("Error processing batch message via Unix socket", e)
                createJsonRpcError(parsed["id"], -32603, e.message ?: "Internal error")
            }

            if (hasId && response != null) {
                responses += json.parseToJsonElement(response)
            }
        }

        if (responses.isEmpty()) {
            return HttpResponse(202, "Accepted", "text/plain", "")
        }

        return HttpResponse(
            200, "OK", "application/json",
            json.encodeToString(JsonArray(responses))
        )
    }

    private fun writeHttpResponse(channel: SocketChannel, response: HttpResponse) {
        val bodyBytes = response.body.toByteArray(Charsets.UTF_8)
        val header = buildString {
            append("HTTP/1.1 ${response.statusCode} ${response.statusText}\r\n")
            append("Content-Type: ${response.contentType}\r\n")
            append("Content-Length: ${bodyBytes.size}\r\n")
            append("Connection: keep-alive\r\n")
            append("\r\n")
        }
        val headerBytes = header.toByteArray(Charsets.UTF_8)
        val buf = ByteBuffer.wrap(headerBytes + bodyBytes)
        while (buf.hasRemaining()) {
            channel.write(buf)
        }
    }

    private val json = Json { encodeDefaults = true; prettyPrint = false }

    private suspend fun <T> runWithIdeModality(block: suspend () -> T): T {
        val application = ApplicationManager.getApplication()
        return if (application == null) {
            block()
        } else {
            withContext(ModalityState.any().asContextElement()) {
                block()
            }
        }
    }

    private fun createJsonRpcError(id: JsonElement?, code: Int, message: String): String {
        val response = JsonRpcResponse(
            id = id,
            error = JsonRpcError(code = code, message = message)
        )
        return json.encodeToString(response)
    }
}
