package dev.pan.app.node

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

object NodeRunner {
    private const val TAG = "PAN-NodeRunner"
    private var libsExtracted = false

    fun getNodeBinaryPath(context: Context): String {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        return "$nativeLibDir/libnode.so"
    }

    private fun getNodeLibsDir(context: Context): File {
        return File(context.filesDir, "node-libs")
    }

    fun extractNodeLibs(context: Context) {
        if (libsExtracted) return
        val libDir = getNodeLibsDir(context)
        libDir.mkdirs()

        val libs = context.assets.list("node-libs") ?: return
        for (lib in libs) {
            val outFile = File(libDir, lib)
            if (outFile.exists() && outFile.length() > 0) continue
            try {
                context.assets.open("node-libs/$lib").use { input ->
                    outFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
                Log.d(TAG, "Extracted $lib (${outFile.length()} bytes)")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to extract $lib: ${e.message}")
            }
        }
        libsExtracted = true
    }

    fun extractAsset(context: Context, assetName: String): File {
        val outDir = File(context.filesDir, "node-scripts")
        outDir.mkdirs()
        val outFile = File(outDir, assetName)
        context.assets.open(assetName).use { input ->
            outFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        return outFile
    }

    suspend fun execute(
        context: Context,
        scriptPath: String,
        args: List<String> = emptyList(),
        env: Map<String, String> = emptyMap(),
        timeoutMs: Long = 30000
    ): NodeResult = withContext(Dispatchers.IO) {
        val nodeBinary = getNodeBinaryPath(context)

        if (!File(nodeBinary).exists()) {
            return@withContext NodeResult(false, "", "libnode.so not found at $nodeBinary", -1)
        }

        // Extract shared libraries if not already done
        extractNodeLibs(context)

        val cmd = mutableListOf(nodeBinary, scriptPath) + args
        Log.d(TAG, "Executing: ${cmd.joinToString(" ")}")

        try {
            val processBuilder = ProcessBuilder(cmd)
            processBuilder.directory(context.filesDir)

            val processEnv = processBuilder.environment()
            processEnv["HOME"] = context.filesDir.absolutePath
            processEnv["TMPDIR"] = context.cacheDir.absolutePath
            processEnv["NODE_OPTIONS"] = "--max-old-space-size=512"

            // Set LD_LIBRARY_PATH so node finds its shared libs
            val nodeLibsDir = getNodeLibsDir(context).absolutePath
            val nativeLibDir = context.applicationInfo.nativeLibraryDir
            processEnv["LD_LIBRARY_PATH"] = "$nodeLibsDir:$nativeLibDir"

            // Add native lib dir to PATH so child_process can find node
            val existingPath = processEnv["PATH"] ?: "/system/bin"
            processEnv["PATH"] = "$nativeLibDir:$existingPath"

            env.forEach { (k, v) -> processEnv[k] = v }
            processBuilder.redirectErrorStream(false)

            val startTime = System.currentTimeMillis()
            val process = processBuilder.start()

            val stdout = process.inputStream.bufferedReader().readText()
            val stderr = process.errorStream.bufferedReader().readText()

            val completed = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
            val elapsed = System.currentTimeMillis() - startTime

            if (!completed) {
                process.destroyForcibly()
                return@withContext NodeResult(false, stdout, "Timed out after ${timeoutMs}ms", -1, elapsed)
            }

            val exitCode = process.exitValue()
            Log.d(TAG, "Node exited with code $exitCode in ${elapsed}ms")

            NodeResult(exitCode == 0, stdout, stderr, exitCode, elapsed)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to execute Node.js", e)
            NodeResult(false, "", e.message ?: "Unknown error", -1)
        }
    }

    suspend fun runTest(context: Context): NodeResult {
        val scriptFile = extractAsset(context, "node-test.js")
        return execute(context, scriptFile.absolutePath)
    }
}

data class NodeResult(
    val success: Boolean,
    val stdout: String,
    val stderr: String,
    val exitCode: Int,
    val elapsedMs: Long = 0
)
