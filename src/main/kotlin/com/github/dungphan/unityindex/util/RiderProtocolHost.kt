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
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

object RiderProtocolHost {

    private val LOG = logger<RiderProtocolHost>()

    private const val FIND_USAGES_TIMEOUT_MS = 30_000L
    private const val GOTO_DECLARATION_TIMEOUT_MS = 15_000L

    fun isRiderEnvironment(): Boolean {
        return try {
            Class.forName("com.jetbrains.rider.projectView.SolutionHostExtensionsKt")
            true
        } catch (_: ClassNotFoundException) {
            false
        }
    }

    fun isCSharpFile(file: VirtualFile): Boolean {
        return file.extension?.lowercase() == "cs"
    }

    fun shouldUseRiderProtocol(file: VirtualFile): Boolean {
        return isRiderEnvironment() && isCSharpFile(file)
    }

    private fun getSolution(project: Project): Any? {
        return try {
            val extensionsKt = Class.forName("com.jetbrains.rider.projectView.SolutionHostExtensionsKt")
            extensionsKt.getMethod("getSolution", Project::class.java).invoke(null, project)
        } catch (e: Exception) {
            LOG.warn("Failed to get Solution from project", e)
            null
        }
    }

    private fun getFindUsagesHost(solution: Any): Any? {
        return try {
            val generatedKt = Class.forName("com.jetbrains.rd.ide.model.FindUsagesModel_GeneratedKt")
            generatedKt.getMethod("getFindUsagesHost", solution.javaClass).invoke(null, solution)
                ?: generatedKt.methods.firstOrNull { it.name == "getFindUsagesHost" }?.invoke(null, solution)
        } catch (e: Exception) {
            LOG.warn("Failed to get FindUsagesHost", e)
            null
        }
    }

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

    suspend fun findUsagesViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): List<RdUsageResult>? {
        val solution = getSolution(project) ?: return null
        val findUsagesHost = getFindUsagesHost(solution) ?: return null

        val sessionsMap = try {
            findUsagesHost.javaClass.getMethod("getSessions").invoke(findUsagesHost)
        } catch (e: Exception) {
            LOG.warn("Failed to get sessions map from FindUsagesHost", e)
            return null
        }

        val existingKeys = getMapKeys(sessionsMap) ?: emptySet()

        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "FindUsages")

            val results = withTimeoutOrNull(FIND_USAGES_TIMEOUT_MS) {
                waitForNewSession(sessionsMap, existingKeys, project)
            }

            return results
        } finally {
            closeEditorIfOpened(project, file, editor)
        }
    }

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

    suspend fun findImplementationsViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): List<RdImplementationResult>? {
        val solution = getSolution(project)
        val findUsagesHost = if (solution != null) getFindUsagesHost(solution) else null

        val sessionsMap = if (findUsagesHost != null) {
            try {
                findUsagesHost.javaClass.getMethod("getSessions").invoke(findUsagesHost)
            } catch (_: Exception) { null }
        } else null

        val existingKeys = if (sessionsMap != null) getMapKeys(sessionsMap) ?: emptySet() else emptySet()

        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "GotoImplementation")

            return withTimeoutOrNull(GOTO_DECLARATION_TIMEOUT_MS) {
                // Monitor both caret navigation (single result) and FindUsages sessions (multiple results)
                repeat(30) {
                    kotlinx.coroutines.delay(500)

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
                        val name = currentFile.nameWithoutExtension

                        listOf(RdImplementationResult(
                            filePath = currentFile.path,
                            line = line,
                            column = column,
                            name = name,
                            kind = "class"
                        ))
                    }
                    if (navResult != null) return@withTimeoutOrNull navResult

                    // Check if results appeared in FindUsages sessions
                    if (sessionsMap != null) {
                        val currentKeys = getMapKeys(sessionsMap) ?: emptySet()
                        val newKeys = currentKeys - existingKeys
                        if (newKeys.isNotEmpty()) {
                            val sessionKey = newKeys.first()
                            val session = getMapValue(sessionsMap, sessionKey) ?: return@repeat
                            val complete = waitForSessionComplete(session)
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
            closeEditorIfOpened(project, file, editor)
        }
    }

    suspend fun typeHierarchyViaRd(
        project: Project,
        file: VirtualFile,
        offset: Int
    ): RdTypeHierarchyResult? {
        val solution = getSolution(project) ?: return null

        val typeHierarchyModel = getTypeHierarchyModel(solution) ?: return null

        val sessionsMap = try {
            typeHierarchyModel.javaClass.getMethod("getSessions").invoke(typeHierarchyModel)
        } catch (e: Exception) {
            LOG.warn("Failed to get sessions from TypeHierarchyModel", e)
            return null
        }

        val existingKeys = getMapKeys(sessionsMap) ?: emptySet()

        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, "TypeHierarchy")

            return withTimeoutOrNull(FIND_USAGES_TIMEOUT_MS) {
                repeat(60) {
                    kotlinx.coroutines.delay(500)

                    val currentKeys = getMapKeys(sessionsMap) ?: return@withTimeoutOrNull null
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
            closeEditorIfOpened(project, file, editor)
        }
    }

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
                kotlinx.coroutines.delay(2000)

                val solution = getSolution(project) ?: return@withTimeoutOrNull null
                val callHierarchyModel = getCallHierarchyModel(solution) ?: return@withTimeoutOrNull null

                val startNewSession = try {
                    callHierarchyModel.javaClass.getMethod("getStartNewSession").invoke(callHierarchyModel)
                } catch (_: Exception) { return@withTimeoutOrNull null }

                val dataContext = withContext(Dispatchers.EDT) {
                    buildRdDataContext(project, editor)
                } ?: return@withTimeoutOrNull null

                val argsClass = Class.forName("com.jetbrains.rider.model.RdCallHierarchySessionStartArgs")
                val args = argsClass.constructors.first { it.parameterCount == 1 }.newInstance(dataContext)

                val session = try {
                    val startMethod = startNewSession.javaClass.methods
                        .firstOrNull { it.name == "sync" && it.parameterCount >= 1 }
                    startMethod?.invoke(startNewSession, args, *Array(startMethod.parameterCount - 1) { null })
                } catch (e: Exception) {
                    LOG.warn("Failed to start call hierarchy session", e)
                    return@withTimeoutOrNull null
                } ?: return@withTimeoutOrNull null

                extractCallHierarchyFromSession(session, direction, depth)
            }
        } finally {
            closeEditorIfOpened(project, file, editor)
        }
    }

    private suspend fun navigateViaAction(
        project: Project,
        file: VirtualFile,
        offset: Int,
        actionId: String
    ): RdDefinitionResult? {
        val editor = openEditorAtOffset(project, file, offset) ?: return null

        try {
            executeAction(project, editor, actionId)

            return withTimeoutOrNull(GOTO_DECLARATION_TIMEOUT_MS) {
                repeat(30) {
                    kotlinx.coroutines.delay(500)

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
            closeEditorIfOpened(project, file, editor)
        }
    }

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

        return RdDefinitionResult(
            filePath = file.path,
            line = line,
            column = column,
            preview = preview
        )
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

                    val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromAnAction(
                        action,
                        null,
                        com.intellij.openapi.actionSystem.ActionPlaces.UNKNOWN,
                        dataContext
                    )

                    action.actionPerformed(event)
                    LOG.info("Executed action '$actionId' at offset in ${editor.document.let { FileDocumentManager.getInstance().getFile(it)?.name }}")
                } else {
                    LOG.warn("Action '$actionId' not found")
                }
            } catch (e: Exception) {
                LOG.warn("Failed to execute action '$actionId'", e)
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private suspend fun waitForNewSession(
        sessionsMap: Any,
        existingKeys: Set<Any>,
        project: Project
    ): List<RdUsageResult>? {
        repeat(60) {
            kotlinx.coroutines.delay(500)

            val currentKeys = getMapKeys(sessionsMap) ?: return null
            val newKeys = currentKeys - existingKeys
            if (newKeys.isNotEmpty()) {
                val sessionKey = newKeys.first()
                val session = getMapValue(sessionsMap, sessionKey) ?: return null

                val isCompleteResult = waitForSessionComplete(session)
                if (isCompleteResult) {
                    return extractUsagesFromSession(session, project)
                }
            }
        }
        return null
    }

    private suspend fun waitForSessionComplete(session: Any): Boolean {
        repeat(60) {
            kotlinx.coroutines.delay(500)

            try {
                val isSearchComplete = session.javaClass.getMethod("isSearchComplete").invoke(session)
                val valueOrNull = isSearchComplete.javaClass.getMethod("getValueOrNull").invoke(isSearchComplete)
                if (valueOrNull == true) return true
            } catch (_: Exception) {
            }
        }
        return false
    }

    @Suppress("UNCHECKED_CAST")
    private fun extractUsagesFromSession(session: Any, project: Project): List<RdUsageResult> {
        val results = mutableListOf<RdUsageResult>()
        try {
            val usageList = session.javaClass.getMethod("getUsages").invoke(session)
            val items = usageList.javaClass.getMethod("getItems").invoke(usageList)
            val itemsList = items.javaClass.getMethod("toList").invoke(items) as? List<*> ?: return results

            for (batch in itemsList) {
                val batchList = batch as? List<*> ?: continue
                for (usageBase in batchList) {
                    if (usageBase == null) continue
                    val usage = extractSingleUsage(usageBase, project)
                    if (usage != null) results.add(usage)
                }
            }
        } catch (e: Exception) {
            LOG.warn("Failed to extract usages from session", e)
        }
        return results
    }

    private fun extractSingleUsage(usageBase: Any, project: Project): RdUsageResult? {
        try {
            val text = usageBase.javaClass.getMethod("getText").invoke(usageBase) as? String ?: ""
            val startOffset = usageBase.javaClass.getMethod("getStartOffset").invoke(usageBase) as? Int ?: 0
            val isRead = usageBase.javaClass.getMethod("isAccessedForReading").invoke(usageBase) as? Boolean ?: false
            val isWrite = usageBase.javaClass.getMethod("isAccessedForWriting").invoke(usageBase) as? Boolean ?: false
            val isGenerated = usageBase.javaClass.getMethod("isGenerated").invoke(usageBase) as? Boolean ?: false

            val fileId = usageBase.javaClass.getMethod("getFileId").invoke(usageBase)
            val filePath = resolveFilePathFromDocumentId(fileId, project) ?: return null

            val groups = usageBase.javaClass.getMethod("getGroups").invoke(usageBase) as? List<*> ?: emptyList<Any>()
            val groupTexts = groups.mapNotNull { group ->
                try {
                    group?.javaClass?.getMethod("getText")?.invoke(group) as? String
                } catch (_: Exception) { null }
            }

            val document = findDocumentForPath(filePath, project)
            val line: Int
            val column: Int
            if (document != null && startOffset < document.textLength) {
                line = document.getLineNumber(startOffset) + 1
                column = startOffset - document.getLineStartOffset(line - 1) + 1
            } else {
                line = 1
                column = 1
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
            LOG.debug("Failed to extract single usage", e)
            return null
        }
    }

    private fun resolveFilePathFromDocumentId(documentId: Any?, project: Project): String? {
        if (documentId == null) return null
        try {
            val docHostClass = Class.forName("com.jetbrains.rdclient.document.FrontendDocumentHost")
            val companionField = docHostClass.getDeclaredField("Companion")
            val companion = companionField.get(null)
            val getInstanceMethod = companion.javaClass.getMethod("getInstance")
            val docHost = getInstanceMethod.invoke(companion)

            val openedDocs = docHostClass.getMethod("getOpenedDocuments").invoke(docHost)
            val getMethod = openedDocs.javaClass.getMethod("get", Object::class.java)
            val document = getMethod.invoke(openedDocs, documentId) as? Document

            if (document != null) {
                val vFile = FileDocumentManager.getInstance().getFile(document)
                if (vFile != null) {
                    return ProjectUtils.getRelativePath(project, vFile)
                }
            }
        } catch (_: Exception) {
        }

        try {
            val fileIdWithFileIdClass = Class.forName("com.jetbrains.rd.ide.model.RdDocumentIdWithFileId")
            if (fileIdWithFileIdClass.isInstance(documentId)) {
                val fileId = fileIdWithFileIdClass.getMethod("getFileId").invoke(documentId)
                if (fileId != null) {
                    val fileIdNewClass = Class.forName("com.jetbrains.rd.ide.model.RdFileIdNew")
                    if (fileIdNewClass.isInstance(fileId)) {
                        val frontendId = fileIdNewClass.getMethod("getFrontendId").invoke(fileId) as Int
                        val vFile = com.intellij.openapi.vfs.VirtualFileManager.getInstance().findFileById(frontendId)
                        if (vFile != null) {
                            return ProjectUtils.getRelativePath(project, vFile)
                        }
                    }
                }
            }
        } catch (_: Exception) {
        }

        return null
    }

    private fun findDocumentForPath(filePath: String, project: Project): Document? {
        val vFile = PsiUtils.resolveVirtualFileAnywhere(project, filePath) ?: return null
        return FileDocumentManager.getInstance().getDocument(vFile)
    }

    @Suppress("UNCHECKED_CAST")
    private fun getMapKeys(map: Any): Set<Any>? {
        return try {
            val keys = map.javaClass.getMethod("getKeys").invoke(map)
            (keys as? Iterable<*>)?.filterNotNull()?.toSet()
        } catch (_: Exception) {
            try {
                val entrySet = map.javaClass.methods.firstOrNull { it.name == "keys" || it.name == "getKeys" }
                entrySet?.invoke(map)?.let { (it as? Iterable<*>)?.filterNotNull()?.toSet() }
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun getMapValue(map: Any, key: Any): Any? {
        return try {
            map.javaClass.getMethod("get", Object::class.java).invoke(map, key)
        } catch (_: Exception) {
            null
        }
    }

    private fun getTypeHierarchyModel(solution: Any): Any? {
        return try {
            val generatedKt = Class.forName("com.jetbrains.rd.ide.model.TypeHierarchyModel_GeneratedKt")
            generatedKt.methods.firstOrNull { it.name == "getTypeHierarchyModel" }?.invoke(null, solution)
        } catch (e: Exception) {
            LOG.warn("Failed to get TypeHierarchyModel", e)
            null
        }
    }

    private fun getCallHierarchyModel(solution: Any): Any? {
        return try {
            val generatedKt = Class.forName("com.jetbrains.rider.model.CallHierarchyModel_PregeneratedKt")
            generatedKt.methods.firstOrNull { it.name == "getCallHierarchyModel" }?.invoke(null, solution)
        } catch (e: Exception) {
            LOG.warn("Failed to get CallHierarchyModel", e)
            null
        }
    }

    private fun extractTypeHierarchyFromSession(session: Any): RdTypeHierarchyResult? {
        try {
            val baseTypeName = try {
                val prop = session.javaClass.getMethod("getBaseTypeName").invoke(session)
                prop?.javaClass?.getMethod("getValue")?.invoke(prop) as? String
            } catch (_: Exception) { null } ?: "Unknown"

            val views = try {
                session.javaClass.getMethod("getViews").invoke(session)
            } catch (_: Exception) { return null } ?: return null

            val allItems = mutableListOf<RdTypeHierarchyItemResult>()

            val viewKeys = getMapKeys(views) ?: return null
            for (viewKey in viewKeys) {
                val view = getMapValue(views, viewKey) ?: continue

                val isReady = try {
                    val readyProp = view.javaClass.getMethod("isReady").invoke(view)
                    readyProp?.javaClass?.getMethod("getValueOrNull")?.invoke(readyProp) as? Boolean
                } catch (_: Exception) { null }

                if (isReady != true) continue

                val itemsMap = try {
                    view.javaClass.getMethod("getItems").invoke(view)
                } catch (_: Exception) { continue } ?: continue

                val itemKeys = getMapKeys(itemsMap) ?: continue
                for (itemKey in itemKeys) {
                    val item = getMapValue(itemsMap, itemKey) ?: continue
                    val treeItem = extractTypeHierarchyItem(item)
                    if (treeItem != null) allItems.add(treeItem)
                }

                if (allItems.isNotEmpty()) break
            }

            if (allItems.isEmpty()) return null

            return RdTypeHierarchyResult(
                baseTypeName = baseTypeName,
                items = allItems
            )
        } catch (e: Exception) {
            LOG.warn("Failed to extract type hierarchy from session", e)
            return null
        }
    }

    private fun extractTypeHierarchyItem(item: Any): RdTypeHierarchyItemResult? {
        return try {
            val id = item.javaClass.getMethod("getId").invoke(item) as Int
            val parentId = item.javaClass.getMethod("getParentId").invoke(item) as? Int
            val typeName = item.javaClass.getMethod("getTypeName").invoke(item) as? String ?: return null
            val containerInfo = item.javaClass.getMethod("getContainerInfo").invoke(item) as? String
            val isBase = item.javaClass.getMethod("isBase").invoke(item) as? Boolean ?: false

            RdTypeHierarchyItemResult(
                typeName = typeName,
                containerInfo = containerInfo,
                isBase = isBase,
                parentId = parentId,
                id = id
            )
        } catch (e: Exception) {
            LOG.debug("Failed to extract type hierarchy item", e)
            null
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun extractCallHierarchyFromSession(
        session: Any,
        direction: String,
        maxDepth: Int
    ): RdCallHierarchyElementResult? {
        try {
            // Set view type (Callers/Callees)
            try {
                val viewTypeClass = Class.forName("com.jetbrains.rider.model.RdCallHierarchyViewType")
                val viewType = viewTypeClass.getMethod("valueOf", String::class.java)
                    .invoke(null, if (direction == "callers") "Callers" else "Callees")
                val setViewType = session.javaClass.getMethod("getSetViewType").invoke(session)
                setViewType.javaClass.getMethod("fire", Object::class.java).invoke(setViewType, viewType)
            } catch (e: Exception) {
                LOG.debug("Failed to set call hierarchy view type", e)
            }

            val rootElement = session.javaClass.getMethod("getRootElement").invoke(session) ?: return null
            return extractCallElement(session, rootElement, 0, maxDepth)
        } catch (e: Exception) {
            LOG.warn("Failed to extract call hierarchy", e)
            return null
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun extractCallElement(
        session: Any,
        element: Any,
        depth: Int,
        maxDepth: Int
    ): RdCallHierarchyElementResult? {
        val id = try { element.javaClass.getMethod("getId").invoke(element) as Int } catch (_: Exception) { return null }
        val filePath = try { element.javaClass.getMethod("getFilePath").invoke(element) as? String } catch (_: Exception) { null }
        val name = try {
            val textModel = element.javaClass.getMethod("getText").invoke(element)
            textModel?.toString() ?: "unknown"
        } catch (_: Exception) { "unknown" }

        var children: List<RdCallHierarchyElementResult>? = null
        if (depth < maxDepth) {
            try {
                val getChildrenCall = session.javaClass.getMethod("getGetChildren").invoke(session)
                val syncMethod = getChildrenCall.javaClass.methods
                    .firstOrNull { it.name == "sync" && it.parameterCount >= 1 }
                if (syncMethod != null) {
                    val childElements = syncMethod.invoke(getChildrenCall, id,
                        *Array(syncMethod.parameterCount - 1) { null }) as? List<*>
                    children = childElements?.mapNotNull { child ->
                        if (child != null) extractCallElement(session, child, depth + 1, maxDepth)
                        else null
                    }
                }
            } catch (e: Exception) {
                LOG.debug("Failed to get children for call hierarchy element $id", e)
            }
        }

        return RdCallHierarchyElementResult(
            name = name,
            filePath = filePath,
            children = children
        )
    }

    private fun buildRdDataContext(project: Project, editor: Editor): List<Any>? {
        return try {
            val providerClass = Class.forName("com.jetbrains.rd.actions.RdDataConstantProvider")
            val companionField = providerClass.getDeclaredField("Companion")
            val companion = companionField.get(null)

            val dataContext = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
                .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
                .add(com.intellij.openapi.actionSystem.CommonDataKeys.EDITOR, editor)
                .add(com.intellij.openapi.actionSystem.PlatformDataKeys.FILE_EDITOR,
                    FileEditorManager.getInstance(project).selectedEditor)
                .build()

            val getConstants = companion.javaClass.methods
                .firstOrNull { it.name == "getDataConstants" }
            @Suppress("UNCHECKED_CAST")
            getConstants?.invoke(companion, dataContext) as? List<Any>
        } catch (e: Exception) {
            LOG.debug("Failed to build RD data context", e)
            null
        }
    }

    private suspend fun closeEditorIfOpened(project: Project, file: VirtualFile, editor: Editor) {
        // Don't close — the user may have had this file open already.
        // Closing it would disrupt their workflow.
    }
}
