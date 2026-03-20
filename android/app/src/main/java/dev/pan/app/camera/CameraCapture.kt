package dev.pan.app.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.ImageCapture.OutputFileOptions
import androidx.camera.core.ImageCapture.OutputFileResults
import androidx.camera.core.ImageCapture.OnImageSavedCallback
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Headless camera capture — takes a photo without showing any UI.
 * Uses CameraX with a fake LifecycleOwner so it works from a Service.
 */
@Singleton
class CameraCapture @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "CameraCapture"
        private const val MAX_DIMENSION = 1024
    }

    private val executor = Executors.newSingleThreadExecutor()
    private var cameraProvider: ProcessCameraProvider? = null
    private var imageCapture: ImageCapture? = null
    private var lifecycleOwner: ServiceLifecycleOwner? = null

    /**
     * Takes a photo using the back camera and returns the JPEG bytes,
     * resized so the longest side is at most MAX_DIMENSION pixels.
     */
    suspend fun takePhoto(): ByteArray = suspendCancellableCoroutine { cont ->
        val mainExecutor = ContextCompat.getMainExecutor(context)

        mainExecutor.execute {
            try {
                val providerFuture = ProcessCameraProvider.getInstance(context)
                providerFuture.addListener({
                    try {
                        val provider = providerFuture.get()
                        cameraProvider = provider

                        // Unbind anything previously bound
                        provider.unbindAll()

                        // Create a lifecycle owner for the camera
                        val owner = ServiceLifecycleOwner()
                        lifecycleOwner = owner
                        owner.start()

                        // Build ImageCapture use case
                        val capture = ImageCapture.Builder()
                            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                            .build()
                        imageCapture = capture

                        // Bind to back camera
                        val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
                        provider.bindToLifecycle(owner, cameraSelector, capture)

                        // Small delay to let auto-exposure settle, then capture to file
                        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                            val photoFile = java.io.File(context.cacheDir, "pan_capture_${System.currentTimeMillis()}.jpg")
                            val outputOptions = OutputFileOptions.Builder(photoFile).build()

                            capture.takePicture(outputOptions, executor, object : OnImageSavedCallback {
                                override fun onImageSaved(output: OutputFileResults) {
                                    try {
                                        val bytes = resizeJpegFile(photoFile)

                                        // Save a copy to Pictures/PAN for the user to see
                                        try {
                                            val picsDir = java.io.File(android.os.Environment.getExternalStoragePublicDirectory(
                                                android.os.Environment.DIRECTORY_PICTURES), "PAN")
                                            picsDir.mkdirs()
                                            val savedFile = java.io.File(picsDir, "pan_${System.currentTimeMillis()}.jpg")
                                            savedFile.writeBytes(bytes)
                                            Log.i(TAG, "Photo saved to: ${savedFile.absolutePath}")
                                        } catch (e: Exception) {
                                            Log.w(TAG, "Could not save to Pictures: ${e.message}")
                                        }

                                        photoFile.delete()
                                        release()
                                        Log.i(TAG, "Photo captured: ${bytes.size} bytes")
                                        cont.resume(bytes)
                                    } catch (e: Exception) {
                                        photoFile.delete()
                                        release()
                                        Log.e(TAG, "Failed to process image: ${e.message}")
                                        cont.resumeWithException(e)
                                    }
                                }

                                override fun onError(exception: ImageCaptureException) {
                                    photoFile.delete()
                                    release()
                                    Log.e(TAG, "Capture failed: ${exception.message}")
                                    cont.resumeWithException(exception)
                                }
                            })
                        }, 800) // 800ms for auto-exposure
                    } catch (e: Exception) {
                        release()
                        Log.e(TAG, "Camera bind failed: ${e.message}")
                        cont.resumeWithException(e)
                    }
                }, mainExecutor)
            } catch (e: Exception) {
                Log.e(TAG, "Camera init failed: ${e.message}")
                cont.resumeWithException(e)
            }
        }

        cont.invokeOnCancellation { release() }
    }

    private fun release() {
        try {
            cameraProvider?.unbindAll()
            lifecycleOwner?.destroy()
            lifecycleOwner = null
            imageCapture = null
        } catch (e: Exception) {
            Log.w(TAG, "Release error: ${e.message}")
        }
    }

    /**
     * Read a JPEG file, apply EXIF rotation, resize to MAX_DIMENSION, return bytes.
     */
    private fun resizeJpegFile(file: java.io.File): ByteArray {
        var bitmap = BitmapFactory.decodeFile(file.absolutePath)
            ?: throw IllegalStateException("Failed to decode image")

        // Read EXIF rotation and apply it to the bitmap
        try {
            val exif = android.media.ExifInterface(file.absolutePath)
            val orientation = exif.getAttributeInt(
                android.media.ExifInterface.TAG_ORIENTATION,
                android.media.ExifInterface.ORIENTATION_NORMAL
            )
            val rotation = when (orientation) {
                android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
            if (rotation != 0f) {
                val matrix = Matrix()
                matrix.postRotate(rotation)
                bitmap = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                Log.i(TAG, "Applied EXIF rotation: ${rotation}°")
            }
        } catch (e: Exception) {
            Log.w(TAG, "EXIF read failed: ${e.message}")
        }

        // Resize so longest side is MAX_DIMENSION
        val w = bitmap.width
        val h = bitmap.height
        val longest = maxOf(w, h)
        if (longest > MAX_DIMENSION) {
            val scale = MAX_DIMENSION.toFloat() / longest
            val newW = (w * scale).toInt()
            val newH = (h * scale).toInt()
            bitmap = Bitmap.createScaledBitmap(bitmap, newW, newH, true)
        }

        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, output)
        return output.toByteArray()
    }

    /**
     * Minimal LifecycleOwner for running CameraX from a Service context.
     */
    private class ServiceLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this)

        override val lifecycle: Lifecycle get() = registry

        fun start() {
            registry.currentState = Lifecycle.State.INITIALIZED
            registry.currentState = Lifecycle.State.CREATED
            registry.currentState = Lifecycle.State.STARTED
        }

        fun destroy() {
            registry.currentState = Lifecycle.State.DESTROYED
        }
    }
}
