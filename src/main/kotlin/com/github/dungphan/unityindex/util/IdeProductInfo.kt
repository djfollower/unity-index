package com.github.dungphan.unityindex.util

import com.intellij.openapi.application.ApplicationInfo

/**
 * Provides IDE-specific information for server configuration.
 *
 * This plugin only runs in JetBrains Rider (product code "RD").
 */
object IdeProductInfo {

    enum class IdeProduct(
        val productCodes: Set<String>,
        val serverName: String,
        val defaultPort: Int,
        val displayName: String
    ) {
        RIDER(setOf("RD"), "unity-index", 29170, "Rider"),
        UNKNOWN(emptySet(), "unity-index", 29170, "Rider");

        companion object {
            /**
             * Find the IdeProduct matching the given product code.
             */
            fun fromProductCode(code: String): IdeProduct {
                return entries.find { code in it.productCodes } ?: UNKNOWN
            }
        }
    }

    // Cached product detection (IDE doesn't change during runtime)
    private val cachedProduct: IdeProduct by lazy {
        detectIdeProductInternal()
    }

    /**
     * Detects the current IDE product using ApplicationInfo.
     * Uses the build's product code which is part of the public API.
     */
    private fun detectIdeProductInternal(): IdeProduct {
        return try {
            val productCode = ApplicationInfo.getInstance().build.productCode
            IdeProduct.fromProductCode(productCode)
        } catch (e: Exception) {
            IdeProduct.UNKNOWN
        }
    }

    /**
     * Gets the detected IDE product.
     */
    fun detectIdeProduct(): IdeProduct = cachedProduct

    /**
     * Gets the IDE-specific server name (e.g., "intellij-index", "pycharm-index").
     */
    fun getServerName(): String = cachedProduct.serverName

    /**
     * Gets the IDE-specific default port.
     */
    fun getDefaultPort(): Int = cachedProduct.defaultPort

    /**
     * Gets the IDE display name.
     */
    fun getIdeDisplayName(): String = cachedProduct.displayName

    /**
     * Gets the raw product code from ApplicationInfo.
     */
    fun getProductCode(): String {
        return try {
            ApplicationInfo.getInstance().build.productCode
        } catch (e: Exception) {
            "UNKNOWN"
        }
    }
}
