plugins {
    id("java")
    alias(libs.plugins.kotlin)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.intelliJPlatform)
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()

    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.ktor.server.core) {
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
        exclude(group = "org.slf4j")
    }
    implementation(libs.ktor.server.cio) {
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
        exclude(group = "org.slf4j")
    }
    implementation(libs.ktor.server.cors) {
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
        exclude(group = "org.slf4j")
    }

    intellijPlatform {
        intellijIdea(providers.gradleProperty("platformVersion"))

        bundledPlugins(providers.gradleProperty("platformBundledPlugins").map {
            it.split(',').filter { s -> s.isNotBlank() }
        })
        plugins(providers.gradleProperty("platformPlugins").map {
            it.split(',').filter { s -> s.isNotBlank() }
        })
        bundledModules(providers.gradleProperty("platformBundledModules").map {
            it.split(',').filter { s -> s.isNotBlank() }
        })
    }
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")

        description = """
            <p><b>Unity C# Codebase Index MCP Server</b> — exposes IDE code intelligence for Unity C# projects
            to AI agents via the <a href="https://modelcontextprotocol.io">Model Context Protocol (MCP)</a>.</p>
            <p>Provides semantic code navigation (find references, go to definition, symbol search, type hierarchy)
            instead of raw text grep, dramatically reducing token usage and improving AI agent accuracy.</p>
        """.trimIndent()

        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
        }
    }
}

tasks {
    wrapper {
        gradleVersion = providers.gradleProperty("gradleVersion").get()
    }
}
