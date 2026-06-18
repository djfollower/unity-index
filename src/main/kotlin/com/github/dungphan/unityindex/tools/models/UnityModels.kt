package com.github.dungphan.unityindex.tools.models

import kotlinx.serialization.Serializable

@Serializable
data class AssemblyDefinition(
    val name: String,
    val file: String,
    val rootNamespace: String? = null,
    val references: List<String> = emptyList(),
    val includePlatforms: List<String> = emptyList(),
    val excludePlatforms: List<String> = emptyList(),
    val allowUnsafeCode: Boolean = false,
    val autoReferenced: Boolean = true,
    val noEngineReferences: Boolean = false,
    val defineConstraints: List<String> = emptyList(),
    val isEditorOnly: Boolean = false
)

@Serializable
data class AssemblyMapResult(
    val assemblies: List<AssemblyDefinition>,
    val totalCount: Int,
    val projectPath: String
)
