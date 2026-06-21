package com.github.dungphan.unityindex.util

import com.intellij.openapi.application.EDT
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

@Suppress("UNCHECKED_CAST")
object RiderProtocolHost {

    private val LOG = logger<RiderProtocolHost>()

    private const val FIND_USAGES_TIMEOUT_MS = 30_000L
    private const val GOTO_TIMEOUT_MS = 15_000L

    // ── Public data classes ──

    data class RdUsageResult(
        val filePath: String,
        val line: Int,
        val column: Int,
        val text: String,
        val isRead: Boolean,
        val isWrite: Boolean,
        val isGenerated: Boolean,
        val groupTexts: List<String>
    )

    data class RdDefinitionResult(
        val filePath: String,
        val line: Int,
        val column: Int,
        val preview: String
    )

    data class RdImplementationResult(
        val filePath: String,
        val line: Int,
        val column: Int,
        val name: String,
        val kind: String
    )

    data class RdTypeHierarchyItemResult(
        val typeName: String,
        val containerInfo: String?,
        val isBase: Boolean,
        val parentId: Int?,
        val id: Int
    )

    data class RdTypeHierarchyResult(
        val baseTypeName: String,
        val items: List<RdTypeHierarchyItemResult>
    )

    data class RdCallHierarchyElementResult(
        val name: String,
        val filePath: String?,
        val children: List<RdCallHierarchyElementResult>?
    )

    // ── Reflection helpers ──

    private fun loadClass(fqn: String): Class<*>? {
        return try {
            Class.forName(fqn)
        } catch (_: ClassNotFoundException) {
            LOG.debug("Class not found: $fqn")
            null
        }
    }

    private fun Any.call(methodName: String, vararg args: Any?): Any? {
        return try {
            val method = this.javaClass.methods.firstOrNull { it.name == methodName }
                ?: throw NoSuchMethodException("$methodName on ${this.javaClass.name}")
            method.invoke(this, *args)
        } catch (e: Exception) {
            LOG.debug("Reflection call $methodName on ${this.javaClass.simpleName} failed: ${e.message}")
            null
        }
    }

    private fun Any.get(propertyName: String): Any? {
        return try {
            val getter = this.javaClass.methods.firstOrNull {
                it.name == "get${propertyName.replaceFirstChar { c -> c.uppercase() }}" && it.parameterCount == 0
            } ?: this.javaClass.methods.firstOrNull {
                it.name == propertyName && it.parameterCount == 0
            }
            getter?.invoke(this)
        } catch (e: Exception) {
            LOG.debug("Reflection get '$propertyName' on ${this.javaClass.simpleName} failed: ${e.message}")
            null
        }
    }

    private fun callStatic(clazz: Class<*>, methodName: String, vararg args: Any?): Any? {
        return try {
            val method = clazz.methods.firstOrNull { it.name == methodName }
                ?: throw NoSuchMethodException("static $methodName on ${clazz.name}")
            method.invoke(null, *args)
        } catch (e: Exception) {
            LOG.debug("Static call $methodName on ${clazz.simpleName} failed: ${e.message}")
            null
        }
    }

    // ── Environment checks ──

    fun isRiderEnvironment(): Boolean {
        return loadClass("com.jetbrains.rider.projectView.SolutionHostExtensionsKt") != null
    }

    fun isCSharpFile(file: VirtualFile): Boolean {
        return file.extension?.lowercase() == "cs"
    }

    fun shouldUseRiderProtocol(file: VirtualFile): Boolean {
        return isRiderEnvironment() && isCSharpFile(file)
    }

    // ── Solution access ──

    private fun getSolution(project: Project): Any? {
        val clazz = loadClass("com.jetbrains.rider.projectView.SolutionHostExtensionsKt") ?: return null
        return callStatic(clazz, "getSolution", project).also {
            if (it == null) LOG.warn("getSolution returned null for project ${project.name}")
            else LOG.info("getSolution returned: ${it.javaClass.name}")
        }
    }

    private fun getFindUsagesHost(solution: Any): Any? {
        val clazz = loadClass("com.jetbrains.rd.ide.model.FindUsagesModel_GeneratedKt") ?: return null
        return callStatic(clazz, "getFindUsagesHost", solution).also {
            if (it == null) LOG.warn("getFindUsagesHost returned null")
            else LOG.info("getFindUsagesHost returned: ${it.javaClass.name}")
        }
    }

    private fun getTypeHierarchyModel(solution: Any): Any? {
        val clazz = loadClass("com.jetbrains.rd.ide.model.TypeHierarchyModel_GeneratedKt") ?: return null
        return callStatic(clazz, "getTypeHierarchyModel", solution).also {
            if (it == null) LOG.warn("getTypeHierarchyModel returned null")
            else LOG.info("getTypeHierarchyModel returned: ${it.javaClass.name}")
        }
    }

    // ── FindUsages ──

    suspend fun findUsagesViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): List<RdUsageResult>? {
        val solution = getSolution(project) ?: return null
        val findUsagesHost = getFindUsagesHost(solution) ?: return null

        val sessionsMap = findUsagesHost.get("sessions") ?: run {
            LOG.warn("FindUsages: could not get sessions map")
            return null
        }

        val existingKeys = getMapKeys(sessionsMap)
        LOG.info("FindUsages: existing session keys = $existingKeys, offset=$offset")

        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "FindUsages")

            return withTimeoutOrNull(FIND_USAGES_TIMEOUT_MS) {
                repeat(60) {
                    delay(500)

                    val currentKeys = getMapKeys(sessionsMap)
                    val newKeys = currentKeys - existingKeys
                    if (newKeys.isNotEmpty()) {
                        val sessionKey = newKeys.first()
                        LOG.info("FindUsages: found new session $sessionKey")
                        val session = getMapValue(sessionsMap, sessionKey) ?: return@repeat

                        val title = session.get("title")
                        LOG.info("FindUsages: session title='$title', waiting for completion...")

                        val isComplete = waitForSearchComplete(session)
                        if (isComplete) {
                            val usages = extractUsagesFromSession(session, project)
                            return@withTimeoutOrNull usages
                        }
                    }
                }
                LOG.warn("FindUsages: timed out waiting for new session")
                null
            }
        } finally {
            // Don't close editor — user may have had it open
        }
    }

    private suspend fun waitForSearchComplete(session: Any): Boolean {
        repeat(60) {
            delay(500)

            val isSearchComplete = session.get("isSearchComplete") ?: return@repeat
            // IOptProperty — get its value
            val value = isSearchComplete.get("value") ?: isSearchComplete.get("valueOrNull")
            if (value == true) {
                LOG.info("FindUsages: search completed")
                return true
            }
        }
        LOG.warn("FindUsages: timed out waiting for search completion")
        return false
    }

    private fun extractUsagesFromSession(session: Any, project: Project): List<RdUsageResult> {
        val results = mutableListOf<RdUsageResult>()
        try {
            val usageList = session.get("usages") ?: run {
                LOG.warn("FindUsages: could not get usages from session")
                return results
            }

            val items = usageList.get("items") ?: run {
                LOG.warn("FindUsages: could not get items from usageList")
                return results
            }

            val itemsList = when (items) {
                is List<*> -> items
                is Iterable<*> -> items.toList()
                else -> {
                    LOG.warn("FindUsages: items is ${items.javaClass.name}, not iterable")
                    return results
                }
            }

            LOG.info("FindUsages: extracting from ${itemsList.size} batches")

            var loggedDiagnostics = false
            for (batch in itemsList) {
                if (batch == null) continue
                val batchItems = when (batch) {
                    is List<*> -> batch
                    is Iterable<*> -> batch.toList()
                    is Array<*> -> batch.toList()
                    else -> {
                        LOG.info("FindUsages: batch is ${batch.javaClass.name}, trying to iterate")
                        try {
                            (batch as Iterable<*>).toList()
                        } catch (_: Exception) {
                            listOf(batch)
                        }
                    }
                }

                LOG.info("FindUsages: batch type=${batch.javaClass.name}, itemCount=${batchItems.size}")

                for (usageBase in batchItems) {
                    if (usageBase == null) continue
                    if (!loggedDiagnostics) {
                        loggedDiagnostics = true
                        logUsageObjectDiagnostics(usageBase)
                    }
                    val usage = extractSingleUsage(usageBase, project)
                    if (usage != null) results.add(usage)
                }
            }
        } catch (e: Exception) {
            LOG.warn("Failed to extract usages from session", e)
        }

        LOG.info("FindUsages: extracted ${results.size} usages total")
        return results
    }

    private fun logUsageObjectDiagnostics(obj: Any) {
        try {
            val className = obj.javaClass.name
            val getters = obj.javaClass.methods
                .filter { it.parameterCount == 0 && it.name.startsWith("get") && it.name != "getClass" }
                .map { method ->
                    val value = try { method.invoke(obj) } catch (_: Exception) { "<error>" }
                    "${method.name}() -> ${value?.javaClass?.simpleName ?: "null"}: ${value?.toString()?.take(100) ?: "null"}"
                }
            val props = obj.javaClass.methods
                .filter { it.parameterCount == 0 && !it.name.startsWith("get") && it.returnType != Void.TYPE }
                .filter { it.name !in setOf("hashCode", "toString", "notify", "notifyAll", "wait") }
                .map { method ->
                    val value = try { method.invoke(obj) } catch (_: Exception) { "<error>" }
                    "${method.name}() -> ${value?.javaClass?.simpleName ?: "null"}: ${value?.toString()?.take(100) ?: "null"}"
                }
            LOG.info("FindUsages: usage object class=$className")
            LOG.info("FindUsages: getters: ${getters.joinToString("; ")}")
            LOG.info("FindUsages: other methods: ${props.take(20).joinToString("; ")}")
        } catch (e: Exception) {
            LOG.warn("FindUsages: failed to log diagnostics for ${obj.javaClass.name}: ${e.message}")
        }
    }

    private fun extractSingleUsage(usageBase: Any, project: Project): RdUsageResult? {
        try {
            val text = (usageBase.get("text") as? String) ?: ""
            val isRead = (usageBase.get("isAccessedForReading") as? Boolean) ?: false
            val isWrite = (usageBase.get("isAccessedForWriting") as? Boolean) ?: false
            val isGenerated = (usageBase.get("isGenerated") as? Boolean) ?: false

            val fileId = usageBase.get("fileId") ?: run {
                LOG.warn("Usage has no fileId, class=${usageBase.javaClass.name}")
                return null
            }

            val filePath = resolveFilePathFromDocumentId(fileId, project) ?: run {
                LOG.warn("Could not resolve file path from ${fileId.javaClass.name}, value=$fileId")
                return null
            }

            val groups = usageBase.get("groups")
            val groupTexts = if (groups is Iterable<*>) {
                groups.mapNotNull { group ->
                    group?.get("text") as? String
                }
            } else emptyList()

            val position = usageBase.get("position")
            val posLine = position?.get("line") as? Int
            val posColumn = position?.get("column") as? Int

            val line: Int
            val column: Int
            if (posLine != null && posColumn != null) {
                line = posLine + 1
                column = posColumn + 1
            } else {
                val startOffset = (usageBase.get("startOffset") as? Int) ?: 0
                val document = findDocumentForPath(filePath, project)
                if (document != null && startOffset < document.textLength) {
                    line = document.getLineNumber(startOffset) + 1
                    column = startOffset - document.getLineStartOffset(line - 1) + 1
                } else {
                    line = 1
                    column = 1
                }
            }

            return RdUsageResult(
                filePath = filePath,
                line = line,
                column = column,
                text = text,
                isRead = isRead,
                isWrite = isWrite,
                isGenerated = isGenerated,
                groupTexts = groupTexts
            )
        } catch (e: Exception) {
            LOG.warn("Failed to extract single usage from ${usageBase.javaClass.name}: ${e.message}", e)
            return null
        }
    }

    // ── GotoDefinition / GotoSuperMethod ──

    suspend fun gotoDefinitionViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): RdDefinitionResult? {
        return navigateViaAction(project, file, offset, "GotoDeclaration")
    }

    suspend fun gotoSuperMethodViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): RdDefinitionResult? {
        return navigateViaAction(project, file, offset, "GotoSuperMethod")
    }

    // ── FindImplementations ──

    suspend fun findImplementationsViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): List<RdImplementationResult>? {
        val solution = getSolution(project)
        val findUsagesHost = if (solution != null) getFindUsagesHost(solution) else null
        val sessionsMap = findUsagesHost?.get("sessions")
        val existingKeys = if (sessionsMap != null) getMapKeys(sessionsMap) else emptySet()

        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "GotoImplementation")

            return withTimeoutOrNull(GOTO_TIMEOUT_MS) {
                repeat(30) {
                    delay(500)

                    // Check if navigated to a single implementation
                    val navResult = withContext(Dispatchers.EDT) {
                        val fem = FileEditorManager.getInstance(project)
                        val currentEditor = fem.selectedTextEditor ?: return@withContext null
                        val currentFile = fem.selectedEditor?.file ?: return@withContext null
                        val caretOffset = currentEditor.caretModel.offset

                        val navigatedAway = currentFile != file
                        val caretMoved = currentFile == file && caretOffset != offset
                        if (!navigatedAway && !caretMoved) return@withContext null

                        val doc = currentEditor.document
                        val line = doc.getLineNumber(caretOffset) + 1
                        val column = caretOffset - doc.getLineStartOffset(line - 1) + 1

                        listOf(RdImplementationResult(
                            filePath = currentFile.path,
                            line = line,
                            column = column,
                            name = currentFile.nameWithoutExtension,
                            kind = "class"
                        ))
                    }
                    if (navResult != null) return@withTimeoutOrNull navResult

                    // Check FindUsages sessions for multi-result implementations
                    if (sessionsMap != null) {
                        val currentKeys = getMapKeys(sessionsMap)
                        val newKeys = currentKeys - existingKeys
                        if (newKeys.isNotEmpty()) {
                            val sessionKey = newKeys.first()
                            val session = getMapValue(sessionsMap, sessionKey) ?: return@repeat
                            val complete = waitForSearchComplete(session)
                            if (complete) {
                                val usages = extractUsagesFromSession(session, project)
                                return@withTimeoutOrNull usages.map { usage ->
                                    RdImplementationResult(
                                        filePath = usage.filePath,
                                        line = usage.line,
                                        column = usage.column,
                                        name = usage.text.take(100),
                                        kind = "class"
                                    )
                                }
                            }
                        }
                    }
                }
                null
            }
        } finally {
            // Don't close editor
        }
    }

    // ── TypeHierarchy ──

    suspend fun typeHierarchyViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): RdTypeHierarchyResult? {
        val solution = getSolution(project) ?: return null
        val typeHierarchyModel = getTypeHierarchyModel(solution) ?: return null

        val sessionsMap = typeHierarchyModel.get("sessions") ?: return null
        val existingKeys = getMapKeys(sessionsMap)

        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "TypeHierarchy")

            return withTimeoutOrNull(FIND_USAGES_TIMEOUT_MS) {
                repeat(60) {
                    delay(500)

                    val currentKeys = getMapKeys(sessionsMap)
                    val newKeys = currentKeys - existingKeys
                    if (newKeys.isNotEmpty()) {
                        val sessionKey = newKeys.first()
                        val session = getMapValue(sessionsMap, sessionKey) ?: return@repeat

                        val result = extractTypeHierarchyFromSession(session)
                        if (result != null) return@withTimeoutOrNull result
                    }
                }
                null
            }
        } finally {
            // Don't close editor
        }
    }

    private fun extractTypeHierarchyFromSession(session: Any): RdTypeHierarchyResult? {
        try {
            val baseTypeNameProp = session.get("baseTypeName")
            val baseTypeName = baseTypeNameProp?.get("value") as? String ?: "Unknown"

            val views = session.get("views") ?: return null
            val allItems = mutableListOf<RdTypeHierarchyItemResult>()

            val viewEntries = when (views) {
                is Map<*, *> -> views.values
                is Iterable<*> -> views.toList()
                else -> return null
            }

            for (viewEntry in viewEntries) {
                val view = viewEntry ?: continue
                val actualView = if (view.javaClass.simpleName.contains("Entry")) {
                    view.call("getValue") ?: continue
                } else view

                val isReadyProp = actualView.get("isReady")
                val isReady = isReadyProp?.get("value")
                if (isReady != true) continue

                val items = actualView.get("items") ?: continue
                val itemEntries = when (items) {
                    is Map<*, *> -> items.values
                    is Iterable<*> -> items.toList()
                    else -> continue
                }

                for (itemEntry in itemEntries) {
                    val item = itemEntry ?: continue
                    val actualItem = if (item.javaClass.simpleName.contains("Entry")) {
                        item.call("getValue") ?: continue
                    } else item

                    allItems.add(RdTypeHierarchyItemResult(
                        typeName = (actualItem.get("typeName") as? String) ?: "?",
                        containerInfo = actualItem.get("containerInfo") as? String,
                        isBase = (actualItem.get("isBase") as? Boolean) ?: false,
                        parentId = actualItem.get("parentId") as? Int,
                        id = (actualItem.get("id") as? Int) ?: 0
                    ))
                }

                if (allItems.isNotEmpty()) break
            }

            if (allItems.isEmpty()) return null

            return RdTypeHierarchyResult(baseTypeName = baseTypeName, items = allItems)
        } catch (e: Exception) {
            LOG.warn("Failed to extract type hierarchy", e)
            return null
        }
    }

    // ── CallHierarchy ──

    suspend fun callHierarchyViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int,
        direction: String,
        depth: Int
    ): RdCallHierarchyElementResult? {
        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "CallHierarchy")

            return withTimeoutOrNull(FIND_USAGES_TIMEOUT_MS) {
                delay(2000)

                val solution = getSolution(project) ?: return@withTimeoutOrNull null

                val callModelClass = loadClass("com.jetbrains.rider.model.CallHierarchyModel_PregeneratedKt")
                val callModel = if (callModelClass != null) {
                    callStatic(callModelClass, "getCallHierarchyModel", solution)
                } else null

                if (callModel == null) {
                    LOG.warn("CallHierarchy: could not get call hierarchy model")
                    return@withTimeoutOrNull null
                }

                val startNewSession = callModel.get("startNewSession") ?: run {
                    LOG.warn("CallHierarchy: no startNewSession RPC")
                    return@withTimeoutOrNull null
                }

                val dataConstants = withContext(Dispatchers.EDT) {
                    buildRdDataConstants(project, editor)
                } ?: return@withTimeoutOrNull null

                val argsClass = loadClass("com.jetbrains.rider.model.RdCallHierarchySessionStartArgs")
                val args = argsClass?.constructors?.firstOrNull()?.newInstance(dataConstants)
                    ?: return@withTimeoutOrNull null

                val session = startNewSession.call("sync", args) ?: run {
                    LOG.warn("CallHierarchy: startNewSession returned null")
                    return@withTimeoutOrNull null
                }

                extractCallHierarchyFromSession(session, direction, depth)
            }
        } finally {
            // Don't close editor
        }
    }

    private fun extractCallHierarchyFromSession(
        session: Any,
        direction: String,
        maxDepth: Int
    ): RdCallHierarchyElementResult? {
        try {
            val viewTypeClass = loadClass("com.jetbrains.rider.model.RdCallHierarchyViewType")
            if (viewTypeClass != null) {
                val viewType = if (direction == "callers") {
                    viewTypeClass.enumConstants?.firstOrNull { it.toString() == "Callers" }
                } else {
                    viewTypeClass.enumConstants?.firstOrNull { it.toString() == "Callees" }
                }
                if (viewType != null) {
                    val setViewType = session.get("setViewType")
                    setViewType?.call("fire", viewType)
                }
            }

            val rootElement = session.get("rootElement") ?: return null
            return extractCallElement(session, rootElement, 0, maxDepth)
        } catch (e: Exception) {
            LOG.warn("Failed to extract call hierarchy", e)
            return null
        }
    }

    private fun extractCallElement(
        session: Any,
        element: Any,
        depth: Int,
        maxDepth: Int
    ): RdCallHierarchyElementResult {
        val name = element.get("text")?.toString() ?: "unknown"
        val filePath = element.get("filePath") as? String

        var children: List<RdCallHierarchyElementResult>? = null
        if (depth < maxDepth) {
            try {
                val id = element.get("id")
                if (id != null) {
                    val getChildren = session.get("getChildren")
                    val childElements = getChildren?.call("sync", id)
                    if (childElements is List<*>) {
                        children = childElements.filterNotNull().map { child ->
                            extractCallElement(session, child, depth + 1, maxDepth)
                        }
                    }
                }
            } catch (e: Exception) {
                LOG.debug("Failed to get children for call element: ${e.message}")
            }
        }

        return RdCallHierarchyElementResult(name = name, filePath = filePath, children = children)
    }

    // ── Navigation via action ──

    private suspend fun navigateViaAction(
        project: Project,
        file: VirtualFile,
        offset: Int,
        actionId: String
    ): RdDefinitionResult? {
        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, actionId)

            return withTimeoutOrNull(GOTO_TIMEOUT_MS) {
                repeat(30) {
                    delay(500)

                    val result = withContext(Dispatchers.EDT) {
                        val fem = FileEditorManager.getInstance(project)
                        val currentEditor = fem.selectedTextEditor ?: return@withContext null
                        val currentFile = fem.selectedEditor?.file ?: return@withContext null
                        val caretOffset = currentEditor.caretModel.offset

                        val navigatedAway = currentFile != file
                        val caretMoved = currentFile == file && caretOffset != offset
                        if (!navigatedAway && !caretMoved) return@withContext null

                        buildDefinitionResult(currentFile, currentEditor.document, caretOffset)
                    }
                    if (result != null) return@withTimeoutOrNull result
                }
                null
            }
        } finally {
            // Don't close editor
        }
    }

    // ── Shared helpers ──

    private fun buildDefinitionResult(
        file: VirtualFile,
        document: Document,
        caretOffset: Int
    ): RdDefinitionResult {
        val line = document.getLineNumber(caretOffset) + 1
        val column = caretOffset - document.getLineStartOffset(line - 1) + 1

        val previewStartLine = maxOf(0, line - 2)
        val previewEndLine = minOf(document.lineCount - 1, line + 2)
        val preview = (previewStartLine until previewEndLine).joinToString("\n") { lineIdx ->
            val start = document.getLineStartOffset(lineIdx)
            val end = document.getLineEndOffset(lineIdx)
            "${lineIdx + 1}: ${document.getText(TextRange(start, end))}"
        }

        return RdDefinitionResult(filePath = file.path, line = line, column = column, preview = preview)
    }

    private suspend fun openEditorAtOffset(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): Editor? {
        return withContext(Dispatchers.EDT) {
            try {
                val descriptor = OpenFileDescriptor(project, file, offset)
                val editor = FileEditorManager.getInstance(project).openTextEditor(descriptor, false)
                if (editor != null) {
                    editor.caretModel.moveToOffset(offset)
                }
                editor
            } catch (e: Exception) {
                LOG.warn("Failed to open editor for ${file.path}", e)
                null
            }
        }
    }

    private suspend fun executeAction(project: Project, editor: Editor, actionId: String) {
        withContext(Dispatchers.EDT) {
            try {
                val actionManager = com.intellij.openapi.actionSystem.ActionManager.getInstance()
                val action = actionManager.getAction(actionId)
                if (action != null) {
                    val dataContext = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
                        .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
                        .add(com.intellij.openapi.actionSystem.CommonDataKeys.EDITOR, editor)
                        .add(com.intellij.openapi.actionSystem.PlatformDataKeys.FILE_EDITOR,
                            FileEditorManager.getInstance(project).selectedEditor)
                        .build()

                    @Suppress("DEPRECATION")
                    val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromAnAction(
                        action, null,
                        com.intellij.openapi.actionSystem.ActionPlaces.UNKNOWN,
                        dataContext
                    )

                    action.actionPerformed(event)
                    LOG.info("Executed action '$actionId'")
                } else {
                    LOG.warn("Action '$actionId' not found")
                }
            } catch (e: Exception) {
                LOG.warn("Failed to execute action '$actionId'", e)
            }
        }
    }

    private fun getMapKeys(map: Any): Set<Any> {
        return try {
            val keys = map.get("keys")
            when (keys) {
                is Set<*> -> keys.filterNotNull().toSet()
                is Collection<*> -> keys.filterNotNull().toSet()
                else -> {
                    (map as? Map<*, *>)?.keys?.filterNotNull()?.toSet() ?: emptySet()
                }
            }
        } catch (e: Exception) {
            LOG.debug("getMapKeys failed: ${e.message}")
            emptySet()
        }
    }

    private fun getMapValue(map: Any, key: Any): Any? {
        return try {
            map.call("get", key)
        } catch (e: Exception) {
            LOG.debug("getMapValue failed for key $key: ${e.message}")
            null
        }
    }

    private fun resolveFilePathFromDocumentId(documentId: Any, project: Project): String? {
        // Strategy 1: FrontendDocumentHost
        try {
            val docHostClass = loadClass("com.jetbrains.rdclient.document.FrontendDocumentHost")
            if (docHostClass != null) {
                val companion = docHostClass.getDeclaredField("Companion").get(null)
                val docHost = companion.call("getInstance")
                if (docHost != null) {
                    val openedDocs = docHost.get("openedDocuments")
                    if (openedDocs != null) {
                        val document = openedDocs.call("get", documentId) as? Document
                        if (document != null) {
                            val vFile = FileDocumentManager.getInstance().getFile(document)
                            if (vFile != null) {
                                return ProjectUtils.getRelativePath(project, vFile)
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            LOG.debug("FrontendDocumentHost lookup failed: ${e.message}")
        }

        // Strategy 2: RdProjectFileDocumentId or similar — extract filePath directly
        try {
            val directPath = documentId.get("filePath") as? String
            if (directPath != null) {
                val vFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(directPath)
                if (vFile != null) {
                    return ProjectUtils.getRelativePath(project, vFile)
                }
                val basePath = project.basePath
                if (basePath != null && directPath.startsWith(basePath)) {
                    return directPath.removePrefix(basePath).removePrefix("/")
                }
                return directPath
            }
        } catch (e: Exception) {
            LOG.debug("Direct filePath extraction failed: ${e.message}")
        }

        // Strategy 3: RdDocumentIdWithFileId → file ID
        try {
            val className = documentId.javaClass.name
            if (className.contains("WithFileId") || className.contains("FileId")) {
                val fileId = documentId.get("fileId")
                if (fileId != null) {
                    val frontendId = fileId.get("frontendId")
                    if (frontendId is Int) {
                        val vFile = com.intellij.openapi.vfs.VirtualFileManager.getInstance()
                            .findFileById(frontendId)
                        if (vFile != null) {
                            return ProjectUtils.getRelativePath(project, vFile)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            LOG.debug("FileId resolution failed: ${e.message}")
        }

        LOG.warn("Could not resolve file path from ${documentId.javaClass.name}: $documentId")
        return null
    }

    private fun findDocumentForPath(filePath: String, project: Project): Document? {
        val vFile = PsiUtils.resolveVirtualFileAnywhere(project, filePath) ?: return null
        return FileDocumentManager.getInstance().getDocument(vFile)
    }

    private fun buildRdDataConstants(project: Project, editor: Editor): Any? {
        return try {
            val providerClass = loadClass("com.jetbrains.rd.actions.RdDataConstantProvider")
            if (providerClass != null) {
                val companion = providerClass.getDeclaredField("Companion").get(null)
                val dataContext = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
                    .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
                    .add(com.intellij.openapi.actionSystem.CommonDataKeys.EDITOR, editor)
                    .add(com.intellij.openapi.actionSystem.PlatformDataKeys.FILE_EDITOR,
                        FileEditorManager.getInstance(project).selectedEditor)
                    .build()
                companion.call("getDataConstants", dataContext)
            } else null
        } catch (e: Exception) {
            LOG.debug("Failed to build RD data constants: ${e.message}")
            null
        }
    }
}
