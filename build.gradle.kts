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

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.serialization.json)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    intellijPlatform {
        rider(providers.gradleProperty("platformVersion"), useInstaller = false)

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

// Graph webview bundle: build via npm workspaces (Vite + Svelte + Sigma) and
// sync into src/main/resources/graph/ so the plugin jar contains it. The
// GraphSchemeHandlerFactory streams files out of that resource dir at runtime.
val isWindowsOs = org.gradle.internal.os.OperatingSystem.current().isWindows
val npmExecutable = if (isWindowsOs) "npm.cmd" else "npm"

val buildGraphWebview by tasks.registering(Exec::class) {
    workingDir = rootDir
    // Inputs: every file that affects the bundle output. Excludes dist/ and
    // node_modules/ to avoid cycles and ignore caches.
    inputs.files(
        fileTree("graph/webview") {
            exclude("dist", "node_modules", "*.log")
        },
        fileTree("graph/core/src"),
    ).withPropertyName("graphWebviewSources")
    inputs.file("package.json").withPropertyName("rootPackageJson")
    inputs.file("package-lock.json").withPropertyName("rootPackageLock")
    outputs.dir("graph/webview/dist").withPropertyName("graphWebviewDist")

    commandLine(npmExecutable, "-w", "@unity-index/graph-webview", "run", "build")
}

val copyGraphBundle by tasks.registering(Sync::class) {
    dependsOn(buildGraphWebview)
    from(layout.projectDirectory.dir("graph/webview/dist"))
    into(layout.projectDirectory.dir("src/main/resources/graph"))
}

tasks {
    wrapper {
        gradleVersion = providers.gradleProperty("gradleVersion").get()
    }

    // Output: build/distributions/unity-index-rider-<version>.zip
    // (kept in lockstep with the VS Code extension's unity-index-vscode-<version>.vsix)
    buildPlugin {
        archiveBaseName.set("unity-index-rider")
    }

    // Inject `pluginVersion` from gradle.properties into version.properties so
    // McpConstants.SERVER_VERSION can read it at runtime without us having to
    // hand-edit the constant on every release. Drift-proof — same source of
    // truth as the artifact filename.
    processResources {
        dependsOn(copyGraphBundle)
        val pluginVersion = providers.gradleProperty("pluginVersion")
        inputs.property("pluginVersion", pluginVersion)
        filesMatching("version.properties") {
            expand("pluginVersion" to pluginVersion.get())
        }
    }

    // Day 6 Task 11: standalone JUnit 5 tests for pure-Kotlin helpers (no
    // IntelliJ platform fixture required). The intellijPlatform plugin owns
    // its own integration-test task; this just lets `./gradlew test` run our
    // plain unit tests against `GraphTraversal` etc.
    test {
        useJUnitPlatform()
    }
}
