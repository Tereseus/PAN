package dev.pan.app.vpn

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import dev.pan.app.ui.theme.PanTheme
import java.util.concurrent.Executors

/**
 * Reads the pairing QR that PAN shows on the computer (its pairing page, /pair/) with the
 * back camera, and hands the code to PairActivity, which asks before it pairs. Decoding
 * runs on the phone (ZXing); no picture is kept or sent anywhere.
 */
class ScanPairActivity : ComponentActivity() {

    private val analysis = Executors.newSingleThreadExecutor()
    private val reader = PairCodeReader()
    private lateinit var previewView: PreviewView
    @Volatile private var done = false

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else {
            Toast.makeText(this, "PAN needs the camera to read the code.", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        previewView = PreviewView(this)
        setContent {
            PanTheme {
                Box(Modifier.fillMaxSize()) {
                    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
                    Text(
                        "Point the camera at the pairing code PAN shows on your computer",
                        modifier = Modifier.align(Alignment.TopCenter).padding(32.dp),
                        color = Color.White,
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    TextButton(
                        onClick = { finish() },
                        modifier = Modifier.align(Alignment.BottomCenter).padding(32.dp),
                    ) { Text("Cancel", color = Color.White) }
                }
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val frames = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                frames.setAnalyzer(analysis) { image -> image.use { frame -> decode(frame)?.let(::found) } }
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, frames)
            } catch (e: Exception) {
                Log.e("PanLink", "pairing scanner: camera failed: ${e.message}")
                Toast.makeText(this, "The camera didn't start: ${e.message}", Toast.LENGTH_LONG).show()
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /** The text of a QR code in the frame's brightness (Y) plane, or null. */
    private fun decode(image: ImageProxy): String? {
        val plane = image.planes[0]
        val buf = plane.buffer
        val data = ByteArray(buf.remaining()).also { buf.get(it) }
        return reader.read(data, plane.rowStride, image.width, image.height)
    }

    private fun found(text: String) {
        if (done || !PairCodeReader.isPairCode(text)) return // another QR: keep looking
        done = true
        runOnUiThread {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(text), this, PairActivity::class.java))
            finish()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        analysis.shutdown()
    }
}

/**
 * Finds a QR code's text in a camera frame's brightness plane (ZXing, on the phone).
 * Rows may be padded ([rowStride] wider than [width]) and the last row may stop short,
 * as CameraX hands them over. Not thread safe: one per analysis thread.
 */
internal class PairCodeReader {
    private val reader = QRCodeReader()
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true)

    fun read(y: ByteArray, rowStride: Int, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(y, rowStride, height, 0, 0, width, height, false)
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (e: Exception) {
            null // no code in this frame (NotFound, Checksum or Format): try the next one
        } finally {
            reader.reset()
        }
    }

    companion object {
        /** Only PAN's own pairing links count; any other QR is ignored. */
        fun isPairCode(text: String): Boolean = text.startsWith("pan://pair?")
    }
}
